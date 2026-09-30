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
    maxToolIterations = 8,
) => {
    const run = (request: ModelRequest) => {
        return {
            async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent, void, unknown> {
                const workingItems: ModelItem[] = request.items.map((item) => ({ ...item }));
                let iterations = 0;

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
                        throw new Error("Maximum tool iterations exceeded");
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

                        if (!toolHost) {
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
                            continue;
                        }

                        const startTime = Date.now();
                        try {
                            const result = await toolHost.execute(call.name, call.arguments);
                            const durationMs = Date.now() - startTime;

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
