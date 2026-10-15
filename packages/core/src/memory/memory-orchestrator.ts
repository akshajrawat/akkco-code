import type { EmbeddingProvider } from "@akkco/models";
import type { ConversationStore } from "@akkco/retrieval";
import type { TranscriptItem } from "../transcript/types.js";
import { createMemoryDocumentFromTurn } from "./memory-document.js";

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

export class ConversationMemoryOrchestrator implements SessionPersistence {
    private readonly inFlightIndexing = new Set<Promise<void>>();

    constructor(
        private readonly store: ConversationStore,
        private readonly embeddingProvider?: EmbeddingProvider,
        private readonly indexingTimeoutMs: number = 5000,
    ) {}

    saveTranscriptItems = async (
        sessionId: string,
        items: readonly TranscriptItem[],
        startSequence: number,
    ): Promise<void> => {
        if (items.length === 0) {
            return;
        }

        const records = items.map((item, index) => ({
            sequence: startSequence + index,
            type: item.type,
            payload: JSON.stringify(item),
        }));

        await this.store.saveTranscriptItems(sessionId, records);
    };

    onTurnCompleted = async (
        sessionId: string,
        turnItems: readonly TranscriptItem[],
        startSequence: number,
        endSequence: number,
        options?: { readonly signal?: AbortSignal },
    ): Promise<void> => {
        const derivedDoc = createMemoryDocumentFromTurn(turnItems, startSequence, endSequence);

        if (!derivedDoc || !this.embeddingProvider) {
            return;
        }

        const embeddingProvider = this.embeddingProvider;

        const runIndexing = async (): Promise<void> => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort(new Error("Memory indexing timed out"));
            }, this.indexingTimeoutMs);

            const onParentAbort = () => {
                controller.abort(options?.signal?.reason ?? new Error("Parent operation aborted"));
            };

            if (options?.signal) {
                if (options.signal.aborted) {
                    clearTimeout(timeoutId);
                    return;
                }
                options.signal.addEventListener("abort", onParentAbort, { once: true });
            }

            try {
                const [embedding] = await embeddingProvider.embed(
                    [derivedDoc.content],
                    controller.signal,
                );
                if (!embedding || embedding.length === 0 || controller.signal.aborted) {
                    return;
                }

                await this.store.saveMemoryDocument({
                    sessionId,
                    startSequence: derivedDoc.startSequence,
                    endSequence: derivedDoc.endSequence,
                    content: derivedDoc.content,
                    embedding,
                    embeddingProvider: embeddingProvider.id,
                    embeddingModel: embeddingProvider.model,
                });
            } catch {
                // Graceful degradation: embedding indexing failure or timeout does not compromise conversation continuity
            } finally {
                clearTimeout(timeoutId);
                if (options?.signal) {
                    options.signal.removeEventListener("abort", onParentAbort);
                }
            }
        };

        const task = runIndexing();
        this.inFlightIndexing.add(task);
        try {
            await task;
        } finally {
            this.inFlightIndexing.delete(task);
        }
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
}
