import type { ContextCompiler } from "./context/bounded-context-compiler.js";
import { compileContext } from "./context/context-compiler.js";
import type { SessionPersistence } from "./memory/memory-orchestrator.js";
import type { RuntimeEvent } from "./runtime/events.js";
import type { AkkcoRuntime } from "./runtime/runtime.js";
import type { TranscriptItem } from "./transcript/types.js";

import type { ModelProfile } from "@akkco/models";

const isAbortError = (error: unknown, signal?: AbortSignal) =>
    Boolean(signal?.aborted) ||
    (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message)));

export interface SessionOptions {
    readonly id?: string;
    readonly compiler?: ContextCompiler;
    readonly persistence?: SessionPersistence;
    readonly initialSequence?: number;
    readonly profile?: ModelProfile;
}

/**
 * Manages conversation lifecycle and exclusively owns the canonical transcript as the
 * authoritative source of truth across user turns and tool executions.
 */
export class Session {
    readonly id: string;
    private readonly compiler?: ContextCompiler;
    private readonly persistence?: SessionPersistence;
    private readonly profile?: ModelProfile;
    private readonly _transcript: TranscriptItem[];
    private _nextSequence: number;
    private _isRunning = false;

    constructor(
        private readonly runtime: AkkcoRuntime,
        initialTranscript: TranscriptItem[] = [],
        options?: SessionOptions,
    ) {
        this.id = options?.id ?? crypto.randomUUID();
        this.compiler = options?.compiler;
        this.persistence = options?.persistence;
        this.profile = options?.profile;
        this._transcript = initialTranscript.map((item) => structuredClone(item));
        this._nextSequence = options?.initialSequence ?? initialTranscript.length;
    }

    get transcript(): TranscriptItem[] {
        return this._transcript.map((item) => structuredClone(item));
    }

    get isRunning(): boolean {
        return this._isRunning;
    }

    /**
     * Dispatches a user prompt through the session, driving context compilation,
     * runtime agent turns, and incremental transcript persistence.
     */
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
                const turnStartIndex = internalTranscript.length;
                const turnStartSequence = self._nextSequence;

                try {
                    internalTranscript.push({ type: "user", content: input });
                    self._nextSequence++;

                    const items = self.compiler
                        ? await self.compiler.compile({
                              transcript: internalTranscript,
                              signal,
                              sessionId: self.id,
                              profile: self.profile,
                          })
                        : compileContext(internalTranscript);

                    for await (const event of runtime.run({
                        items,
                        signal,
                        profile: self.profile,
                    })) {
                        if (signal?.aborted) {
                            const err = new Error("The operation was aborted");
                            err.name = "AbortError";
                            throw err;
                        }
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
                                self._nextSequence++;
                                assistantText = "";
                            }

                            internalTranscript.push({
                                type: "tool_execution",
                                callId: event.callId,
                                toolName: event.toolName,
                                arguments: structuredClone(event.arguments),
                                result: event.result,
                                error: event.error,
                                status: event.status,
                                durationMs: event.durationMs,
                            });
                            self._nextSequence++;

                            yield event;
                        }
                    }

                    if (signal?.aborted) {
                        const err = new Error("The operation was aborted");
                        err.name = "AbortError";
                        throw err;
                    }

                    completed = true;
                    internalTranscript.push({
                        type: "assistant",
                        content: assistantText,
                        status: "completed",
                    });
                    self._nextSequence++;
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
                    self._nextSequence++;
                    throw error;
                } finally {
                    try {
                        if (!completed && !errorOccurred) {
                            internalTranscript.push({
                                type: "assistant",
                                content: assistantText,
                                status: "interrupted",
                            });
                            self._nextSequence++;
                        }

                        if (self.persistence) {
                            const turnItems = internalTranscript.slice(turnStartIndex);
                            const turnEndSequence = self._nextSequence - 1;
                            try {
                                await self.persistence.saveTranscriptItems(
                                    self.id,
                                    turnItems,
                                    turnStartSequence,
                                );
                            } catch (persistError) {
                                if (completed && !errorOccurred) {
                                    throw persistError;
                                }
                            }

                            if (completed) {
                                try {
                                    await self.persistence.onTurnCompleted?.(
                                        self.id,
                                        turnItems,
                                        turnStartSequence,
                                        turnEndSequence,
                                        { signal },
                                    );
                                } catch {
                                    // Memory indexing failure must NEVER fail an otherwise completed turn
                                }
                            }
                        }
                    } finally {
                        self._isRunning = false;
                    }
                }
            },
        };
    };

    clear = (): void => {
        if (this._isRunning) {
            throw new Error("Cannot clear session while generation is in progress");
        }
        this._transcript.length = 0;
        this._nextSequence = 0;
    };
}

export const createAkkcoSession = (
    runtime: AkkcoRuntime,
    initialTranscript: TranscriptItem[] = [],
    options?: SessionOptions,
) => new Session(runtime, initialTranscript, options);
