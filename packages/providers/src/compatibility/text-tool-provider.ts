import { randomUUID } from "node:crypto";
import type {
    ModelEvent,
    ModelItem,
    ModelProvider,
    ModelRequest,
    ModelTextEvent,
    ModelToolCallEvent,
} from "@akkco/models";
import {
    classifyCompatibilityTurn,
    COMPATIBILITY_REPAIR_INSTRUCTION,
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

interface ReadTurnResult {
    rawText: string;
    bufferedText: string;
    nativeToolCallEmitted: boolean;
}

export class TextToolCompatibilityProvider implements ModelProvider {
    readonly id: string;

    constructor(private readonly provider: ModelProvider) {
        this.id = `${provider.id}-compatibility`;
    }

    private async *readTurn(
        request: ModelRequest,
    ): AsyncGenerator<ModelEvent, ReadTurnResult, unknown> {
        let rawText = "";
        let bufferedText = "";
        let state: "DETECTING" | "STREAMING_PROSE" | "SUPPRESSING" = "DETECTING";

        for await (const event of this.provider.stream(request)) {
            throwIfAborted(request.signal);

            if (event.type === "tool_call") {
                if (bufferedText.length > 0) {
                    yield { type: "text", content: bufferedText } satisfies ModelTextEvent;
                    bufferedText = "";
                }
                yield event;
                return { rawText, bufferedText: "", nativeToolCallEmitted: true };
            }

            rawText += event.content;

            if (rawText.includes("akkco_tool")) {
                state = "SUPPRESSING";
                bufferedText = "";
                continue;
            }

            bufferedText += event.content;

            if (state === "DETECTING") {
                const trimmed = bufferedText.trimStart();
                if (trimmed === "") {
                    continue;
                }

                if (
                    TOOL_CALL_OPEN_TAG.startsWith(trimmed) ||
                    trimmed.startsWith(TOOL_CALL_OPEN_TAG) ||
                    trimmed.startsWith("```") ||
                    "```".startsWith(trimmed)
                ) {
                    continue;
                }

                state = "STREAMING_PROSE";
            }

            if (state === "STREAMING_PROSE") {
                const angleIndex = bufferedText.indexOf("<");
                const fenceIndex = bufferedText.indexOf("```");
                const markerIndex =
                    angleIndex !== -1 && fenceIndex !== -1
                        ? Math.min(angleIndex, fenceIndex)
                        : angleIndex !== -1
                          ? angleIndex
                          : fenceIndex;

                if (markerIndex === -1) {
                    yield { type: "text", content: bufferedText } satisfies ModelTextEvent;
                    bufferedText = "";
                } else if (markerIndex > 0) {
                    const safeProse = bufferedText.slice(0, markerIndex);
                    yield { type: "text", content: safeProse } satisfies ModelTextEvent;
                    bufferedText = bufferedText.slice(markerIndex);
                }
            }
        }

        throwIfAborted(request.signal);

        return {
            rawText,
            bufferedText,
            nativeToolCallEmitted: false,
        };
    }

    stream = (request: ModelRequest): AsyncIterable<ModelEvent> => {
        const self = this;

        return {
            async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent, void, unknown> {
                throwIfAborted(request.signal);

                const hasTools = Boolean(request.tools && request.tools.length > 0);
                if (!hasTools) {
                    yield* self.provider.stream(request);
                    return;
                }

                const compatItems = transformRequestHistoryForCompatibility(
                    request.items,
                    request.tools,
                );

                const initialRequest: ModelRequest = {
                    items: compatItems,
                    tools: undefined,
                    signal: request.signal,
                };

                const turn1 = yield* self.readTurn(initialRequest);
                if (turn1.nativeToolCallEmitted) {
                    return;
                }

                const classification1 = classifyCompatibilityTurn(turn1.rawText, request.tools!);

                if (classification1.type === "valid_tool_call") {
                    throwIfAborted(request.signal);
                    yield {
                        type: "tool_call",
                        id: `compat_${randomUUID()}`,
                        name: classification1.toolCall.name,
                        arguments: classification1.toolCall.arguments,
                    } satisfies ModelToolCallEvent;
                    return;
                }

                if (classification1.type === "normal_prose") {
                    if (turn1.bufferedText.length > 0) {
                        yield {
                            type: "text",
                            content: turn1.bufferedText,
                        } satisfies ModelTextEvent;
                    }
                    return;
                }

                // classification1 is "protocol_violation" -> initiate one repair turn
                throwIfAborted(request.signal);

                const repairItems: ModelItem[] = [
                    ...compatItems,
                    {
                        type: "message",
                        role: "assistant",
                        content: turn1.rawText,
                    },
                    {
                        type: "message",
                        role: "user",
                        content: COMPATIBILITY_REPAIR_INSTRUCTION,
                    },
                ];

                const repairRequest: ModelRequest = {
                    items: repairItems,
                    tools: undefined,
                    signal: request.signal,
                };

                const turn2 = yield* self.readTurn(repairRequest);
                if (turn2.nativeToolCallEmitted) {
                    return;
                }

                const classification2 = classifyCompatibilityTurn(turn2.rawText, request.tools!);

                if (classification2.type === "valid_tool_call") {
                    throwIfAborted(request.signal);
                    yield {
                        type: "tool_call",
                        id: `compat_${randomUUID()}`,
                        name: classification2.toolCall.name,
                        arguments: classification2.toolCall.arguments,
                    } satisfies ModelToolCallEvent;
                    return;
                }

                if (classification2.type === "normal_prose") {
                    if (turn2.bufferedText.length > 0) {
                        yield {
                            type: "text",
                            content: turn2.bufferedText,
                        } satisfies ModelTextEvent;
                    }
                    return;
                }

                // Failed repair: second consecutive protocol violation
                const reasonDetail = classification2.reason.replace(
                    /^Compatibility tool protocol error:\s*/i,
                    "",
                );
                throw new Error(
                    `Compatibility tool protocol error: model failed protocol repair; ${reasonDetail}`,
                );
            },
        };
    };
}

export const createTextToolCompatibilityProvider = (provider: ModelProvider): ModelProvider =>
    new TextToolCompatibilityProvider(provider);
