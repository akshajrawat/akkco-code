import type { EmbeddingProvider } from "@akkco/models";
import type { ConversationStore } from "@akkco/retrieval";
import type { TranscriptItem } from "../transcript/types.js";
import { createMemoryDocumentFromTurn } from "./memory-document.js";

export interface MemoryIndexingDiagnostic {
    readonly stage: "indexing";
    readonly provider: string;
    readonly model: string;
    readonly message: string;
}

export interface ConversationMemoryOrchestratorOptions {
    readonly indexingTimeoutMs?: number;
    readonly maxConcurrency?: number;
    readonly onDiagnostic?: (diagnostic: MemoryIndexingDiagnostic) => void;
    readonly debug?: boolean;
}

export interface SessionPersistence {
    saveTranscriptItems(
        sessionId: string,
        items: readonly TranscriptItem[],
        startSequence: number,
    ): Promise<void>;

    onTurnCompleted?(
        sessionId: string,
        turnItems: readonly TranscriptItem[],
        startSequence: number,
        endSequence: number,
        options?: { readonly signal?: AbortSignal },
    ): Promise<void>;
}

/**
 * Orchestrates transcript record persistence and asynchronous background memory indexing
 * with coordinated timeout bounding, bounded concurrency, and drain coordination during shutdown.
 */
export class ConversationMemoryOrchestrator implements SessionPersistence {
    private readonly inFlightIndexing = new Set<Promise<void>>();
    private readonly queue: Array<{
        readonly run: () => Promise<void>;
        readonly cancel: () => void;
    }> = [];
    private readonly activeControllers = new Set<AbortController>();
    private activeCount = 0;
    private _isClosed = false;
    readonly maxConcurrency: number;
    readonly indexingTimeoutMs: number;
    private readonly onDiagnostic?: (diagnostic: MemoryIndexingDiagnostic) => void;
    private readonly debug?: boolean;

    get isClosed(): boolean {
        return this._isClosed;
    }

    constructor(
        private readonly store: ConversationStore,
        private readonly embeddingProvider?: EmbeddingProvider,
        indexingTimeoutOrOptions?: number | ConversationMemoryOrchestratorOptions,
    ) {
        const providerBudget =
            typeof (embeddingProvider as any)?.overallTimeoutBudgetMs === "number"
                ? (embeddingProvider as any).overallTimeoutBudgetMs + 5000
                : typeof (embeddingProvider as any)?.timeoutMs === "number"
                  ? (embeddingProvider as any).timeoutMs * 3 + 10000
                  : 5000;

        const defaultTimeout =
            embeddingProvider?.id === "gemini" ? Math.max(45000, providerBudget) : providerBudget;

        if (typeof indexingTimeoutOrOptions === "number") {
            this.indexingTimeoutMs = indexingTimeoutOrOptions;
            this.maxConcurrency = 1;
        } else if (indexingTimeoutOrOptions && typeof indexingTimeoutOrOptions === "object") {
            this.indexingTimeoutMs = indexingTimeoutOrOptions.indexingTimeoutMs ?? defaultTimeout;
            this.maxConcurrency =
                typeof indexingTimeoutOrOptions.maxConcurrency === "number" &&
                indexingTimeoutOrOptions.maxConcurrency > 0
                    ? indexingTimeoutOrOptions.maxConcurrency
                    : 1;
            this.onDiagnostic = indexingTimeoutOrOptions.onDiagnostic;
            this.debug = indexingTimeoutOrOptions.debug;
        } else {
            this.indexingTimeoutMs = defaultTimeout;
            this.maxConcurrency = 1;
        }
    }

    saveTranscriptItems = async (
        sessionId: string,
        items: readonly TranscriptItem[],
        startSequence: number,
    ): Promise<void> => {
        if (this._isClosed || items.length === 0) {
            return;
        }

        const records = items.map((item, index) => ({
            sequence: startSequence + index,
            type: item.type,
            payload: JSON.stringify(item),
        }));

        await this.store.saveTranscriptItems(sessionId, records);
    };

    /**
     * Handles completed turn persistence by deriving a memory document and indexing it
     * with an embedding vector in the background with bounded concurrency and timeout.
     */
    onTurnCompleted = async (
        sessionId: string,
        turnItems: readonly TranscriptItem[],
        startSequence: number,
        endSequence: number,
        options?: { readonly signal?: AbortSignal },
    ): Promise<void> => {
        if (this._isClosed) {
            return;
        }

        const derivedDoc = createMemoryDocumentFromTurn(turnItems, startSequence, endSequence);

        if (!derivedDoc || !this.embeddingProvider) {
            return;
        }

        const embeddingProvider = this.embeddingProvider;

        const runIndexing = async (): Promise<void> => {
            if (this._isClosed) {
                return;
            }

            const controller = new AbortController();
            this.activeControllers.add(controller);

            const timeoutId = setTimeout(() => {
                controller.abort(new Error("Memory indexing timed out"));
            }, this.indexingTimeoutMs);

            const onParentAbort = () => {
                controller.abort(options?.signal?.reason ?? new Error("Parent operation aborted"));
            };

            if (options?.signal) {
                if (options.signal.aborted) {
                    clearTimeout(timeoutId);
                    this.activeControllers.delete(controller);
                    return;
                }
                options.signal.addEventListener("abort", onParentAbort, { once: true });
            }

            try {
                const [embedding] = await embeddingProvider.embed(
                    [derivedDoc.content],
                    controller.signal,
                    { taskType: "RETRIEVAL_DOCUMENT" },
                );
                if (
                    this._isClosed ||
                    controller.signal.aborted ||
                    !embedding ||
                    embedding.length === 0
                ) {
                    return;
                }

                // Full original memory document is stored in SQLite
                await this.store.saveMemoryDocument({
                    sessionId,
                    startSequence: derivedDoc.startSequence,
                    endSequence: derivedDoc.endSequence,
                    content: derivedDoc.content,
                    embedding,
                    embeddingProvider: embeddingProvider.id,
                    embeddingModel: embeddingProvider.model,
                });
            } catch (error) {
                if (this._isClosed || controller.signal.aborted) {
                    return;
                }

                // Graceful degradation: embedding indexing failure or timeout does not compromise conversation continuity
                const isDebug =
                    this.debug ??
                    (typeof process !== "undefined" &&
                        (process.env.AKKCO_EMBEDDING_DEBUG === "true" ||
                            process.env.AKKCO_DEBUG === "true"));

                if (this.onDiagnostic || isDebug) {
                    const rawMsg = error instanceof Error ? error.message : String(error);
                    const sanitized = rawMsg.replace(/[a-zA-Z0-9_-]{20,}/g, "[REDACTED]");
                    const diag: MemoryIndexingDiagnostic = {
                        stage: "indexing",
                        provider: embeddingProvider.id,
                        model: embeddingProvider.model,
                        message: sanitized,
                    };
                    this.onDiagnostic?.(diag);
                    if (isDebug) {
                        process.stderr.write(
                            `[embedding-diagnostic] Provider "${diag.provider}" (${diag.model}) indexing failed: ${sanitized}\n`,
                        );
                    }
                }
            } finally {
                clearTimeout(timeoutId);
                this.activeControllers.delete(controller);
                if (options?.signal) {
                    options.signal.removeEventListener("abort", onParentAbort);
                }
            }
        };

        return new Promise<void>((resolve, reject) => {
            let trackingResolve: () => void;
            const trackingPromise = new Promise<void>((r) => {
                trackingResolve = r;
            });
            this.inFlightIndexing.add(trackingPromise);

            const taskWrapper = async () => {
                if (this._isClosed) {
                    resolve();
                    return;
                }
                try {
                    await runIndexing();
                    resolve();
                } catch (err) {
                    if (this._isClosed) {
                        resolve();
                    } else {
                        reject(err);
                    }
                } finally {
                    this.inFlightIndexing.delete(trackingPromise);
                    trackingResolve();
                }
            };

            const cancel = () => {
                this.inFlightIndexing.delete(trackingPromise);
                trackingResolve();
                resolve();
            };

            this.queue.push({ run: taskWrapper, cancel });
            this.drainQueue();
        });
    };

    private drainQueue = (): void => {
        if (this._isClosed) {
            return;
        }
        while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
            const next = this.queue.shift();
            if (!next) {
                break;
            }
            this.activeCount++;
            void next.run().finally(() => {
                this.activeCount--;
                this.drainQueue();
            });
        }
    };

    /**
     * Aborts all active indexing operations, clears queued tasks, and marks orchestrator as closed.
     * Prevents any pending or future operations from attempting writes to SQLite.
     */
    cancelPending = (): void => {
        this._isClosed = true;
        for (const item of this.queue) {
            item.cancel();
        }
        this.queue.length = 0;
        for (const controller of this.activeControllers) {
            try {
                controller.abort(new Error("Memory indexing cancelled during shutdown"));
            } catch {}
        }
        this.activeControllers.clear();
    };

    waitForPendingIndexing = async (timeoutMs = 5000): Promise<void> => {
        if (this.inFlightIndexing.size === 0) {
            return;
        }

        const waitPromise = Promise.allSettled(Array.from(this.inFlightIndexing)).then(() => {});
        let timer: NodeJS.Timeout;
        const timeoutPromise = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
        });

        await Promise.race([waitPromise, timeoutPromise]);
        clearTimeout(timer!);
    };

    /**
     * Closes the memory orchestrator with bounded shutdown.
     * Awaits in-flight indexing up to drainTimeoutMs (defaulting to the lesser of indexingTimeoutMs and 3000ms),
     * and guarantees all remaining or queued operations are cancelled and aborted before returning.
     */
    close = async (drainTimeoutMs?: number): Promise<void> => {
        const timeout = drainTimeoutMs ?? Math.min(this.indexingTimeoutMs, 3000);
        try {
            if (timeout > 0) {
                await this.waitForPendingIndexing(timeout);
            }
        } finally {
            this.cancelPending();
        }
    };
}
