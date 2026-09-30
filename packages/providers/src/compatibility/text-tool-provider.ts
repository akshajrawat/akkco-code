import { randomUUID } from "node:crypto";
import type {
    ModelEvent,
    ModelProvider,
    ModelRequest,
    ModelTextEvent,
    ModelToolCallEvent,
} from "@akkco/models";
import {
    parseCompatibilityToolCall,
    TOOL_CALL_CLOSE_TAG,
    TOOL_CALL_OPEN_TAG,
    transformRequestHistoryForCompatibility,
} from "./text-tool-protocol.js";

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

export class TextToolCompatibilityProvider implements ModelProvider {
    readonly id: string;

    constructor(private readonly provider: ModelProvider) {
        this.id = `${provider.id}-compatibility`;
    }

    stream = (request: ModelRequest): AsyncIterable<ModelEvent> => {
        const { provider } = this;

        return {
            async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent, void, unknown> {
                throwIfAborted(request.signal);

                const hasTools = Boolean(request.tools && request.tools.length > 0);
                if (!hasTools) {
                    yield* provider.stream(request);
                    return;
                }

                const compatItems = transformRequestHistoryForCompatibility(
                    request.items,
                    request.tools,
                );

                const compatRequest: ModelRequest = {
                    items: compatItems,
                    tools: undefined,
                    signal: request.signal,
                };

                let state: "DETECTING" | "TOOL_BUFFERING" | "PASSTHROUGH" = "DETECTING";
                let buffer = "";

                for await (const event of provider.stream(compatRequest)) {
                    throwIfAborted(request.signal);

                    if (event.type === "tool_call") {
                        if (buffer.length > 0) {
                            yield { type: "text", content: buffer } satisfies ModelTextEvent;
                            buffer = "";
                        }
                        yield event;
                        continue;
                    }

                    if (state === "PASSTHROUGH") {
                        yield event;
                        continue;
                    }

                    buffer += event.content;

                    if (state === "DETECTING") {
                        const trimmedStart = buffer.trimStart();

                        if (trimmedStart === "") {
                            continue;
                        }

                        if (trimmedStart.length < TOOL_CALL_OPEN_TAG.length) {
                            if (TOOL_CALL_OPEN_TAG.startsWith(trimmedStart)) {
                                continue;
                            }
                        } else if (trimmedStart.startsWith(TOOL_CALL_OPEN_TAG)) {
                            state = "TOOL_BUFFERING";
                            const closeIndex = buffer.indexOf(TOOL_CALL_CLOSE_TAG);
                            if (closeIndex !== -1) {
                                const afterClose = buffer.slice(
                                    closeIndex + TOOL_CALL_CLOSE_TAG.length,
                                );
                                if (afterClose.includes(TOOL_CALL_OPEN_TAG)) {
                                    throw new Error(
                                        "Compatibility tool protocol error: model emitted multiple tool calls in one turn; only one is supported.",
                                    );
                                }
                                if (
                                    afterClose.trim() !== "" &&
                                    !TOOL_CALL_OPEN_TAG.startsWith(afterClose.trimStart())
                                ) {
                                    throw new Error(
                                        "Compatibility tool protocol error: model emitted unexpected text after tool call envelope; no prose allowed outside envelope.",
                                    );
                                }
                            }
                            continue;
                        }

                        state = "PASSTHROUGH";
                        yield { type: "text", content: buffer } satisfies ModelTextEvent;
                        buffer = "";
                        continue;
                    }

                    if (state === "TOOL_BUFFERING") {
                        const closeIndex = buffer.indexOf(TOOL_CALL_CLOSE_TAG);
                        if (closeIndex !== -1) {
                            const afterClose = buffer.slice(
                                closeIndex + TOOL_CALL_CLOSE_TAG.length,
                            );
                            if (afterClose.includes(TOOL_CALL_OPEN_TAG)) {
                                throw new Error(
                                    "Compatibility tool protocol error: model emitted multiple tool calls in one turn; only one is supported.",
                                );
                            }
                            if (
                                afterClose.trim() !== "" &&
                                !TOOL_CALL_OPEN_TAG.startsWith(afterClose.trimStart())
                            ) {
                                throw new Error(
                                    "Compatibility tool protocol error: model emitted unexpected text after tool call envelope; no prose allowed outside envelope.",
                                );
                            }
                        }
                    }
                }

                throwIfAborted(request.signal);

                if (state === "PASSTHROUGH") {
                    return;
                }

                if (state === "DETECTING") {
                    if (buffer.length > 0) {
                        yield { type: "text", content: buffer } satisfies ModelTextEvent;
                    }
                    return;
                }

                if (!buffer.includes(TOOL_CALL_CLOSE_TAG)) {
                    throw new Error(
                        "Compatibility tool protocol error: unclosed <akkco_tool_call> envelope; closing tag is missing.",
                    );
                }

                const openCount = buffer.split(TOOL_CALL_OPEN_TAG).length - 1;
                const closeCount = buffer.split(TOOL_CALL_CLOSE_TAG).length - 1;
                if (openCount > 1 || closeCount > 1) {
                    throw new Error(
                        "Compatibility tool protocol error: model emitted multiple tool calls in one turn; only one is supported.",
                    );
                }

                const closeIndex = buffer.indexOf(TOOL_CALL_CLOSE_TAG);
                const afterClose = buffer.slice(closeIndex + TOOL_CALL_CLOSE_TAG.length);
                if (afterClose.trim() !== "") {
                    throw new Error(
                        "Compatibility tool protocol error: model emitted unexpected text after tool call envelope; no prose allowed outside envelope.",
                    );
                }

                const parsed = parseCompatibilityToolCall(buffer, request.tools!);
                yield {
                    type: "tool_call",
                    id: `compat_${randomUUID()}`,
                    name: parsed.name,
                    arguments: parsed.arguments,
                } satisfies ModelToolCallEvent;
            },
        };
    };
}

export const createTextToolCompatibilityProvider = (provider: ModelProvider): ModelProvider =>
    new TextToolCompatibilityProvider(provider);
