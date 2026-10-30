import type {
    ModelItem,
    ModelProfile,
    ModelProvider,
    ModelRequest,
    ModelToolCallEvent,
} from "@akkco/models";
import { ensureBoundedProvider } from "../context/bounded-model-provider.js";
import type { ContextBudget } from "../context/budget.js";
import type { ContextCompactor } from "../context/context-compactor.js";
import {
    deriveDeterministicDid,
    reconstructContextWithMilestones,
} from "../context/milestone-context.js";
import { prepareBoundedModelRequest } from "../context/request-preparer.js";
import type { RuntimeEvent, RuntimeTextEvent, RuntimeToolExecutionEvent } from "./events.js";
import { createMilestoneProcessor, type MilestoneProcessor } from "./milestones/processor.js";
import type { ToolMilestone } from "./milestones/types.js";
import {
    AgentLoopError,
    detectRepeatedToolCycle,
    getToolCallSignature,
    validateReliabilityOptions,
    type RuntimeReliabilityOptions,
} from "./reliability.js";
import type { RuntimeToolHost } from "./tool-host.js";

const throwIfAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) {
        if (typeof signal.throwIfAborted === "function") {
            signal.throwIfAborted();
        }
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
    }
};

export interface AkkcoRuntimeOptions {
    readonly toolHost?: RuntimeToolHost;
    readonly reliabilityOptions?: RuntimeReliabilityOptions;
    readonly budget?: ContextBudget;
    readonly compactor?: ContextCompactor;
    readonly maxToolOutputTokens?: number;
    readonly profile?: ModelProfile;
    readonly milestoneProcessor?: MilestoneProcessor;
    readonly summarizerProvider?: ModelProvider;
}

/**
 * Core agent runtime coordinating the multi-turn model-tool execution loop.
 * Milestone-based context reconstruction is the authoritative model-facing mechanism:
 * every completed tool execution is represented as an evidence-backed milestone rather than
 * endlessly replaying raw outputs and assistant narration into subsequent model requests.
 */
export const createAkkcoRuntime = (
    provider: ModelProvider,
    toolHostOrOptions?: RuntimeToolHost | AkkcoRuntimeOptions,
    reliabilityOptions?: RuntimeReliabilityOptions,
    budget?: ContextBudget,
    compactor?: ContextCompactor,
    maxToolOutputTokens?: number,
) => {
    const isOptionsObject =
        toolHostOrOptions !== undefined &&
        typeof (toolHostOrOptions as any)?.execute !== "function" &&
        ("toolHost" in toolHostOrOptions ||
            "reliabilityOptions" in toolHostOrOptions ||
            "budget" in toolHostOrOptions ||
            "compactor" in toolHostOrOptions ||
            "maxToolOutputTokens" in toolHostOrOptions ||
            "profile" in toolHostOrOptions ||
            "milestoneProcessor" in toolHostOrOptions ||
            "summarizerProvider" in toolHostOrOptions);

    const options: AkkcoRuntimeOptions = isOptionsObject
        ? (toolHostOrOptions as AkkcoRuntimeOptions)
        : {
              toolHost: toolHostOrOptions as RuntimeToolHost | undefined,
              reliabilityOptions,
              budget,
              compactor,
              maxToolOutputTokens,
          };

    const toolHost = options.toolHost;
    const effectiveBudget = options.budget;
    const effectiveMaxToolOutputTokens = options.maxToolOutputTokens;
    const effectiveProfile = options.profile;

    const effectiveProvider = ensureBoundedProvider(provider, {
        profile: effectiveProfile,
        budget: effectiveBudget,
        maxToolOutputTokens: effectiveMaxToolOutputTokens,
    });

    const effectiveMilestoneProcessor =
        options.milestoneProcessor ??
        createMilestoneProcessor({
            provider: options.summarizerProvider,
            profile: effectiveProfile,
            budget: effectiveBudget,
            maxMilestoneTokens: effectiveMaxToolOutputTokens,
        });

    const { maxToolIterations, repeatedToolCallLimit, consecutiveToolErrorLimit } =
        validateReliabilityOptions(options.reliabilityOptions);

    const run = (request: ModelRequest) => {
        return {
            async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent, void, unknown> {
                const resolvedProfile = request.profile ?? effectiveProfile;
                const initialBaseItems: ModelItem[] = request.items.map((item) => ({ ...item }));
                const completedMilestones: ToolMilestone[] = [];

                // Identify the root user goal from the initial request
                let parentGoalItem: ModelItem | undefined;
                for (let i = request.items.length - 1; i >= 0; i--) {
                    const item = request.items[i];
                    if (item.type === "message" && item.role === "user") {
                        parentGoalItem = item;
                        break;
                    }
                }
                const parentGoalText =
                    parentGoalItem && parentGoalItem.type === "message"
                        ? parentGoalItem.content
                        : "";
                const parentGoalId = `goal-${Date.now()}`;

                let iterations = 0;
                let consecutiveToolErrors = 0;
                let lastSignature: string | undefined;
                let repetitionCount = 0;
                let repetitionWarned = false;

                const recentSignatures: string[] = [];
                let cycleWarned = false;
                let warnedCallSignature: string | undefined;

                while (true) {
                    throwIfAborted(request.signal);

                    // Reconstruct model-visible context exclusively from initial base items
                    // (policy, memory context, and user prompt) plus completed milestones.
                    const effectiveItems: ModelItem[] =
                        completedMilestones.length > 0
                            ? reconstructContextWithMilestones(
                                  initialBaseItems,
                                  completedMilestones,
                              )
                            : initialBaseItems;

                    const effectiveRequest: ModelRequest = {
                        items: effectiveItems,
                        tools: toolHost?.tools,
                        signal: request.signal,
                        profile: resolvedProfile,
                    };

                    // Enforce token budget bounds before invoking the provider
                    if (effectiveBudget) {
                        prepareBoundedModelRequest({
                            request: effectiveRequest,
                            budget: effectiveBudget,
                            profile: resolvedProfile,
                            maxToolOutputTokens: effectiveMaxToolOutputTokens,
                        });
                    }

                    let turnAssistantText = "";
                    const toolCallEvents: ModelToolCallEvent[] = [];

                    for await (const event of effectiveProvider.stream(effectiveRequest)) {
                        throwIfAborted(request.signal);
                        if (event.type === "text") {
                            turnAssistantText += event.content;
                            yield {
                                type: "text",
                                content: event.content,
                            } satisfies RuntimeTextEvent;
                        } else if (event.type === "tool_call") {
                            toolCallEvents.push(event);
                        }
                    }

                    throwIfAborted(request.signal);

                    if (toolCallEvents.length === 0) {
                        return;
                    }

                    iterations++;
                    if (iterations > maxToolIterations) {
                        throwIfAborted(request.signal);
                        throw new AgentLoopError(
                            "max_tool_iterations",
                            `Maximum tool iterations exceeded (${maxToolIterations})`,
                        );
                    }

                    for (const call of toolCallEvents) {
                        throwIfAborted(request.signal);

                        const signature = getToolCallSignature(call.name, call.arguments);

                        if (signature === lastSignature) {
                            repetitionCount++;

                            if (repetitionWarned) {
                                throwIfAborted(request.signal);
                                throw new AgentLoopError(
                                    "repeated_tool_call",
                                    `Agent loop terminated: repeated tool call detected for "${call.name}" with identical arguments without strategy change.`,
                                );
                            }

                            if (repetitionCount >= repeatedToolCallLimit) {
                                repetitionWarned = true;
                                const warningMessage = `Repeated tool call: action "${call.name}" with identical arguments was called ${repetitionCount} times. You must change your strategy and choose another action or arguments.`;

                                const milestone =
                                    await effectiveMilestoneProcessor.processToolExecution({
                                        parentGoal: parentGoalText,
                                        parentGoalId,
                                        callId: call.id,
                                        toolName: call.name,
                                        arguments: call.arguments,
                                        executionStatus: "failed",
                                        error: warningMessage,
                                        durationMs: 0,
                                        signal: request.signal,
                                        profile: resolvedProfile,
                                        index: completedMilestones.length + 1,
                                    });
                                completedMilestones.push(milestone);

                                yield {
                                    type: "tool_execution",
                                    callId: call.id,
                                    toolName: call.name,
                                    arguments: call.arguments,
                                    error: warningMessage,
                                    status: "failed",
                                    durationMs: 0,
                                    milestone,
                                } satisfies RuntimeToolExecutionEvent;

                                continue;
                            }
                        } else {
                            lastSignature = signature;
                            repetitionCount = 1;
                            repetitionWarned = false;
                        }

                        const cycleResult = detectRepeatedToolCycle(recentSignatures, signature);

                        if (
                            cycleResult.isCycle ||
                            (cycleWarned && signature === warnedCallSignature)
                        ) {
                            if (cycleWarned) {
                                throwIfAborted(request.signal);
                                throw new AgentLoopError(
                                    "repeated_tool_cycle",
                                    "Agent loop terminated: repeated tool strategy cycle detected without strategy change.",
                                );
                            }

                            cycleWarned = true;
                            warnedCallSignature = signature;
                            recentSignatures.push(signature);
                            if (recentSignatures.length > 30) {
                                recentSignatures.shift();
                            }

                            const warningMessage =
                                "Repeated tool strategy: pattern of recent tool calls is repeating. You must change your strategy and use existing evidence or choose another approach.";

                            const milestone =
                                await effectiveMilestoneProcessor.processToolExecution({
                                    parentGoal: parentGoalText,
                                    parentGoalId,
                                    callId: call.id,
                                    toolName: call.name,
                                    arguments: call.arguments,
                                    executionStatus: "failed",
                                    error: warningMessage,
                                    durationMs: 0,
                                    signal: request.signal,
                                    profile: resolvedProfile,
                                    index: completedMilestones.length + 1,
                                });
                            completedMilestones.push(milestone);

                            yield {
                                type: "tool_execution",
                                callId: call.id,
                                toolName: call.name,
                                arguments: call.arguments,
                                error: warningMessage,
                                status: "failed",
                                durationMs: 0,
                                milestone,
                            } satisfies RuntimeToolExecutionEvent;

                            continue;
                        } else {
                            if (cycleWarned) {
                                cycleWarned = false;
                                warnedCallSignature = undefined;
                            }
                            recentSignatures.push(signature);
                            if (recentSignatures.length > 30) {
                                recentSignatures.shift();
                            }
                        }

                        if (!toolHost) {
                            consecutiveToolErrors++;
                            const errorMsg = `No tool host available to execute tool: ${call.name}`;

                            const milestone =
                                await effectiveMilestoneProcessor.processToolExecution({
                                    parentGoal: parentGoalText,
                                    parentGoalId,
                                    callId: call.id,
                                    toolName: call.name,
                                    arguments: call.arguments,
                                    executionStatus: "failed",
                                    error: errorMsg,
                                    durationMs: 0,
                                    signal: request.signal,
                                    profile: resolvedProfile,
                                    index: completedMilestones.length + 1,
                                });
                            completedMilestones.push(milestone);

                            yield {
                                type: "tool_execution",
                                callId: call.id,
                                toolName: call.name,
                                arguments: call.arguments,
                                error: errorMsg,
                                status: "failed",
                                durationMs: 0,
                                milestone,
                            } satisfies RuntimeToolExecutionEvent;

                            if (consecutiveToolErrors >= consecutiveToolErrorLimit) {
                                throwIfAborted(request.signal);
                                throw new AgentLoopError(
                                    "consecutive_tool_errors",
                                    `Agent loop terminated: reached consecutive tool error limit of ${consecutiveToolErrorLimit}.`,
                                );
                            }
                            continue;
                        }

                        // Execute the tool and capture original uncompacted output
                        let rawResult: string | undefined;
                        let executionError: string | undefined;
                        let executionDurationMs = 0;
                        const startTime = Date.now();

                        try {
                            const result = await toolHost.execute(call.name, call.arguments);
                            executionDurationMs = Date.now() - startTime;
                            rawResult = result.content;
                            consecutiveToolErrors = 0;
                        } catch (error) {
                            throwIfAborted(request.signal);
                            consecutiveToolErrors++;
                            executionDurationMs = Date.now() - startTime;
                            executionError = error instanceof Error ? error.message : String(error);
                        }

                        if (executionError !== undefined) {
                            // Tool execution failed
                            const milestone =
                                await effectiveMilestoneProcessor.processToolExecution({
                                    parentGoal: parentGoalText,
                                    parentGoalId,
                                    callId: call.id,
                                    toolName: call.name,
                                    arguments: call.arguments,
                                    executionStatus: "failed",
                                    error: executionError,
                                    durationMs: executionDurationMs,
                                    signal: request.signal,
                                    profile: resolvedProfile,
                                    index: completedMilestones.length + 1,
                                });
                            completedMilestones.push(milestone);

                            yield {
                                type: "tool_execution",
                                callId: call.id,
                                toolName: call.name,
                                arguments: call.arguments,
                                error: executionError,
                                status: "failed",
                                durationMs: executionDurationMs,
                                milestone,
                            } satisfies RuntimeToolExecutionEvent;

                            if (consecutiveToolErrors >= consecutiveToolErrorLimit) {
                                throwIfAborted(request.signal);
                                throw new AgentLoopError(
                                    "consecutive_tool_errors",
                                    `Agent loop terminated: reached consecutive tool error limit of ${consecutiveToolErrorLimit}.`,
                                );
                            }
                        } else {
                            // Tool execution succeeded.
                            // Process completed milestone. If milestone processing fails,
                            // the tool execution itself remains marked as completed.
                            let milestone: ToolMilestone;
                            try {
                                milestone = await effectiveMilestoneProcessor.processToolExecution({
                                    parentGoal: parentGoalText,
                                    parentGoalId,
                                    callId: call.id,
                                    toolName: call.name,
                                    arguments: call.arguments,
                                    rawResult,
                                    executionStatus: "completed",
                                    durationMs: executionDurationMs,
                                    signal: request.signal,
                                    profile: resolvedProfile,
                                    index: completedMilestones.length + 1,
                                });
                            } catch (milestoneErr) {
                                throwIfAborted(request.signal);
                                const mErrorMsg =
                                    milestoneErr instanceof Error
                                        ? milestoneErr.message
                                        : String(milestoneErr);

                                const mIndex = completedMilestones.length + 1;
                                milestone = {
                                    id: `milestone-${call.id}`,
                                    parentGoalId,
                                    callId: call.id,
                                    toolName: call.name,
                                    arguments: call.arguments,
                                    executionStatus: "completed", // Tool succeeded!
                                    processingStatus: "failed", // Milestone processing failed!
                                    error: mErrorMsg,
                                    durationMs: executionDurationMs,
                                    did: deriveDeterministicDid(
                                        call.name,
                                        call.arguments,
                                        "completed",
                                        undefined,
                                        rawResult,
                                    ),
                                    summary: `Tool execution succeeded, but milestone processing failed: ${mErrorMsg}`,
                                    findings: [],
                                    unresolvedQuestions: [
                                        "Milestone processing failed; raw evidence preserved in transcript.",
                                    ],
                                    omissions:
                                        "Tool output processing failed; full raw output preserved in transcript.",
                                    evidenceRefs: [`call:${call.id}`],
                                    estimatedTokens: 50,
                                    index: mIndex,
                                };
                            }
                            completedMilestones.push(milestone);

                            yield {
                                type: "tool_execution",
                                callId: call.id,
                                toolName: call.name,
                                arguments: call.arguments,
                                result: rawResult,
                                status: "completed",
                                durationMs: executionDurationMs,
                                milestone,
                            } satisfies RuntimeToolExecutionEvent;
                        }
                    }

                    throwIfAborted(request.signal);
                }
            },
        };
    };

    return { run };
};

export type AkkcoRuntime = ReturnType<typeof createAkkcoRuntime>;
