import type {
    ModelItem,
    ModelMessage,
    ModelProfile,
    ModelProvider,
    ModelRequest,
    ModelToolCall,
    ModelToolCallEvent,
    ModelToolResult,
} from "@akkco/models";
import { ensureBoundedProvider } from "../context/bounded-model-provider.js";
import type { ContextBudget } from "../context/budget.js";
import type { ContextCompactor } from "../context/context-compactor.js";
import {
    calculateAvailableToolTokens,
    ContextBudgetOverflowError,
    prepareBoundedModelRequest,
} from "../context/request-preparer.js";
import type { RuntimeEvent, RuntimeTextEvent, RuntimeToolExecutionEvent } from "./events.js";
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
}

/**
 * Core agent runtime coordinating the multi-turn model-tool execution loop
 * while enforcing reliability controls and cycle detection.
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
            "profile" in toolHostOrOptions);

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
    const effectiveCompactor = options.compactor;
    const effectiveMaxToolOutputTokens = options.maxToolOutputTokens;
    const effectiveProfile = options.profile;

    const effectiveProvider = ensureBoundedProvider(provider, {
        profile: effectiveProfile,
        budget: effectiveBudget,
        maxToolOutputTokens: effectiveMaxToolOutputTokens,
    });

    const { maxToolIterations, repeatedToolCallLimit, consecutiveToolErrorLimit } =
        validateReliabilityOptions(options.reliabilityOptions);

    const run = (request: ModelRequest) => {
        return {
            async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent, void, unknown> {
                const resolvedProfile = request.profile ?? effectiveProfile;
                const workingItems: ModelItem[] = request.items.map((item) => ({ ...item }));
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

                    const effectiveRequest: ModelRequest = {
                        items: workingItems,
                        tools: toolHost?.tools,
                        signal: request.signal,
                        profile: resolvedProfile,
                    };

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

                    if (turnAssistantText.length > 0) {
                        const assistantMessage: ModelMessage = {
                            type: "message",
                            role: "assistant",
                            content: turnAssistantText,
                        };
                        workingItems.push(assistantMessage);
                    }

                    for (const call of toolCallEvents) {
                        const toolCallItem: ModelToolCall = {
                            type: "tool_call",
                            id: call.id,
                            name: call.name,
                            arguments: call.arguments,
                        };
                        workingItems.push(toolCallItem);
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

                                const resultItem: ModelToolResult = {
                                    type: "tool_result",
                                    callId: call.id,
                                    content: warningMessage,
                                    isError: true,
                                };
                                workingItems.push(resultItem);

                                yield {
                                    type: "tool_execution",
                                    callId: call.id,
                                    toolName: call.name,
                                    arguments: call.arguments,
                                    error: warningMessage,
                                    status: "failed",
                                    durationMs: 0,
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

                            const resultItem: ModelToolResult = {
                                type: "tool_result",
                                callId: call.id,
                                content: warningMessage,
                                isError: true,
                            };
                            workingItems.push(resultItem);

                            yield {
                                type: "tool_execution",
                                callId: call.id,
                                toolName: call.name,
                                arguments: call.arguments,
                                error: warningMessage,
                                status: "failed",
                                durationMs: 0,
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
                            const resultItem: ModelToolResult = {
                                type: "tool_result",
                                callId: call.id,
                                content: errorMsg,
                                isError: true,
                            };
                            workingItems.push(resultItem);

                            yield {
                                type: "tool_execution",
                                callId: call.id,
                                toolName: call.name,
                                arguments: call.arguments,
                                error: errorMsg,
                                status: "failed",
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

                        const startTime = Date.now();
                        try {
                            const result = await toolHost.execute(call.name, call.arguments);
                            const durationMs = Date.now() - startTime;

                            consecutiveToolErrors = 0;

                            let toolContentForWorkingItems = result.content;
                            if (effectiveCompactor) {
                                let fitsWithoutCompaction = false;
                                try {
                                    prepareBoundedModelRequest({
                                        request: {
                                            items: [
                                                ...workingItems,
                                                {
                                                    type: "tool_result",
                                                    callId: call.id,
                                                    content: result.content,
                                                },
                                            ],
                                            tools: toolHost?.tools,
                                            signal: request.signal,
                                            profile: resolvedProfile,
                                        },
                                        budget: effectiveBudget,
                                        profile: resolvedProfile,
                                        maxToolOutputTokens: effectiveMaxToolOutputTokens,
                                    });
                                    fitsWithoutCompaction = true;
                                } catch (overflowErr) {
                                    if (overflowErr instanceof ContextBudgetOverflowError) {
                                        fitsWithoutCompaction = false;
                                    } else {
                                        throw overflowErr;
                                    }
                                }

                                if (!fitsWithoutCompaction) {
                                    const targetToolBudget = calculateAvailableToolTokens({
                                        items: workingItems,
                                        tools: toolHost?.tools,
                                        profile: resolvedProfile,
                                        budget: effectiveBudget,
                                        maxToolOutputTokens: effectiveMaxToolOutputTokens,
                                    });

                                    if (targetToolBudget > 0) {
                                        try {
                                            const compacted =
                                                await effectiveCompactor.compactToolResult({
                                                    toolName: call.name,
                                                    callId: call.id,
                                                    content: result.content,
                                                    targetTokens: targetToolBudget,
                                                    signal: request.signal,
                                                });
                                            if (compacted) {
                                                toolContentForWorkingItems = compacted;
                                            }
                                        } catch (compactionErr) {
                                            if (
                                                request.signal?.aborted ||
                                                (compactionErr instanceof Error &&
                                                    compactionErr.name === "AbortError")
                                            ) {
                                                throw compactionErr;
                                            }
                                            // On compaction error, retain original content and allow downstream preflight to fail closed
                                        }
                                    }
                                }
                            }

                            const resultItem: ModelToolResult = {
                                type: "tool_result",
                                callId: call.id,
                                content: toolContentForWorkingItems,
                            };
                            workingItems.push(resultItem);

                            yield {
                                type: "tool_execution",
                                callId: call.id,
                                toolName: call.name,
                                arguments: call.arguments,
                                result: result.content,
                                status: "completed",
                                durationMs,
                            } satisfies RuntimeToolExecutionEvent;
                        } catch (error) {
                            throwIfAborted(request.signal);

                            consecutiveToolErrors++;

                            const durationMs = Date.now() - startTime;
                            const errorMessage =
                                error instanceof Error ? error.message : String(error);

                            const resultItem: ModelToolResult = {
                                type: "tool_result",
                                callId: call.id,
                                content: errorMessage,
                                isError: true,
                            };
                            workingItems.push(resultItem);

                            yield {
                                type: "tool_execution",
                                callId: call.id,
                                toolName: call.name,
                                arguments: call.arguments,
                                error: errorMessage,
                                status: "failed",
                                durationMs,
                            } satisfies RuntimeToolExecutionEvent;

                            if (consecutiveToolErrors >= consecutiveToolErrorLimit) {
                                throwIfAborted(request.signal);
                                throw new AgentLoopError(
                                    "consecutive_tool_errors",
                                    `Agent loop terminated: reached consecutive tool error limit of ${consecutiveToolErrorLimit}.`,
                                );
                            }
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
