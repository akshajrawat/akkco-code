import { compileContext } from "./context/context-compiler.js";
import type { RuntimeEvent } from "./runtime/events.js";
import type { AkkcoRuntime } from "./runtime/runtime.js";
import type { TranscriptItem } from "./transcript/types.js";

const isAbortError = (error: unknown, signal?: AbortSignal) =>
    Boolean(signal?.aborted) ||
    (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message)));

export class Session {
    private readonly _transcript: TranscriptItem[];
    private _isRunning = false;

    constructor(private readonly runtime: AkkcoRuntime, initialTranscript: TranscriptItem[] = []) {
        this._transcript = initialTranscript.map((item) => ({ ...item }));
    }

    get transcript() {
        return this._transcript.map((item) => ({ ...item }));
    }

    get isRunning() {
        return this._isRunning;
    }

    send = (input: string, signal?: AbortSignal) => {
        const runtime = this.runtime;
        const internalTranscript = this._transcript;
        const self = this;

        return {
            async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent, void, unknown> {
                if (self._isRunning) {
                    throw new Error("A generation is already in progress for this session");
                }
                self._isRunning = true;

                let assistantText = "";
                let completed = false;
                let errorOccurred = false;

                try {
                    internalTranscript.push({ type: "user", content: input });
                    const items = compileContext(internalTranscript);

                    for await (const event of runtime.run({ items, signal })) {
                        if (event.type === "text") {
                            assistantText += event.content;
                            yield event;
                        } else if (event.type === "tool_execution") {
                            if (assistantText.length > 0) {
                                internalTranscript.push({
                                    type: "assistant",
                                    content: assistantText,
                                    status: "completed",
                                });
                                assistantText = "";
                            }

                            internalTranscript.push({
                                type: "tool_execution",
                                callId: event.callId,
                                toolName: event.toolName,
                                arguments: event.arguments,
                                result: event.result,
                                error: event.error,
                                status: event.status,
                                durationMs: event.durationMs,
                            });

                            yield event;
                        }
                    }

                    completed = true;
                    internalTranscript.push({
                        type: "assistant",
                        content: assistantText,
                        status: "completed",
                    });
                } catch (error) {
                    errorOccurred = true;
                    if (isAbortError(error, signal)) {
                        internalTranscript.push({
                            type: "assistant",
                            content: assistantText,
                            status: "interrupted",
                        });
                    } else {
                        internalTranscript.push({
                            type: "assistant",
                            content: assistantText,
                            status: "failed",
                        });
                    }
                    throw error;
                } finally {
                    try {
                        if (!completed && !errorOccurred) {
                            internalTranscript.push({
                                type: "assistant",
                                content: assistantText,
                                status: "interrupted",
                            });
                        }
                    } finally {
                        self._isRunning = false;
                    }
                }
            },
        };
    };

    clear = () => {
        if (this._isRunning) {
            throw new Error("Cannot clear session while generation is in progress");
        }
        this._transcript.length = 0;
    };
}

export const createAkkcoSession = (runtime: AkkcoRuntime, initialTranscript: TranscriptItem[] = []) =>
    new Session(runtime, initialTranscript);
