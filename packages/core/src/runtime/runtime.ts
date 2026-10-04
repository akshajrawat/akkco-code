import type {
    ModelItem,
    ModelMessage,
    ModelProvider,
    ModelRequest,
    ModelToolCall,
    ModelToolCallEvent,
    ModelToolResult,
} from "@akkco/models";
import type { RuntimeEvent, RuntimeTextEvent, RuntimeToolExecutionEvent } from "./events.js";
import {
    AgentLoopError,
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

export const createAkkcoRuntime = (
    provider: ModelProvider,
    toolHost?: RuntimeToolHost,
    reliabilityOptions?: RuntimeReliabilityOptions,
) => {
    const { maxToolIterations, repeatedToolCallLimit, consecutiveToolErrorLimit } =
        validateReliabilityOptions(reliabilityOptions);

    const run = (request: ModelRequest) => {
        return {
            async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent, void, unknown> {
                const workingItems: ModelItem[] = request.items.map((item) => ({ ...item }));
                let iterations = 0;
                let consecutiveToolErrors = 0;
                let lastSignature: string | undefined;
                let repetitionCount = 0;
                let repetitionWarned = false;

                while (true) {
                    throwIfAborted(request.signal);

                    let turnAssistantText = "";
                    const toolCallEvents: ModelToolCallEvent[] = [];

                    for await (const event of provider.stream({
                        items: workingItems,
                        tools: toolHost?.tools,
                        signal: request.signal,
                    })) {
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

                            const resultItem: ModelToolResult = {
                                type: "tool_result",
                                callId: call.id,
                                content: result.content,
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
