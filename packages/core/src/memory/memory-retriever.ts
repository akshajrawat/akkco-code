import type { EmbeddingIdentity, EmbeddingProvider } from "@akkco/models";
import type { ConversationStore, MemoryCandidate, StoredMemoryDocument } from "@akkco/retrieval";
import { estimateTokens } from "../context/token-estimator.js";

export interface QueryEmbedding {
    readonly text: string;
    readonly vector: readonly number[];
    readonly identity: EmbeddingIdentity;
}

export interface ConversationMemoryCandidate {
    readonly document: StoredMemoryDocument;
    readonly similarity: number;
    readonly estimatedTokens: number;
}

export interface ConversationMemoryRetrieveOptions {
    readonly queryEmbedding?: QueryEmbedding;
    readonly queryText?: string;
    readonly sessionId?: string;
    readonly excludeSequenceRange?: { readonly start: number; readonly end: number };
    readonly limit?: number;
    readonly signal?: AbortSignal;
}

export interface MemoryRetrievalDiagnostic {
    readonly stage: "query";
    readonly provider: string;
    readonly model: string;
    readonly message: string;
}

export interface ConversationMemoryRetriever {
    retrieve(options: ConversationMemoryRetrieveOptions): Promise<ConversationMemoryCandidate[]>;
    embedQuery(text: string, signal?: AbortSignal): Promise<QueryEmbedding | null>;
}

export interface ConversationMemoryRetrieverOptions {
    readonly onDiagnostic?: (diagnostic: MemoryRetrievalDiagnostic) => void;
    readonly debug?: boolean;
}

export class DefaultConversationMemoryRetriever implements ConversationMemoryRetriever {
    private readonly onDiagnostic?: (diagnostic: MemoryRetrievalDiagnostic) => void;
    private readonly debug?: boolean;

    constructor(
        private readonly store: ConversationStore,
        private readonly embeddingProvider?: EmbeddingProvider,
        onDiagnosticOrOptions?:
            ((diagnostic: MemoryRetrievalDiagnostic) => void) | ConversationMemoryRetrieverOptions,
    ) {
        if (typeof onDiagnosticOrOptions === "function") {
            this.onDiagnostic = onDiagnosticOrOptions;
        } else if (onDiagnosticOrOptions && typeof onDiagnosticOrOptions === "object") {
            this.onDiagnostic = onDiagnosticOrOptions.onDiagnostic;
            this.debug = onDiagnosticOrOptions.debug;
        }
    }

    /**
     * Generates an embedding vector for search queries, capturing provider identity
     * and degrading gracefully if the embedding provider is offline.
     */
    embedQuery = async (text: string, signal?: AbortSignal): Promise<QueryEmbedding | null> => {
        if (!this.embeddingProvider || !text.trim()) {
            return null;
        }

        if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        try {
            const [vector] = await this.embeddingProvider.embed([text], signal, {
                taskType: "RETRIEVAL_QUERY",
            });
            if (!vector || vector.length === 0) {
                return null;
            }

            return {
                text,
                vector,
                identity: {
                    provider: this.embeddingProvider.id,
                    model: this.embeddingProvider.model,
                    dimensions: vector.length,
                },
            };
        } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
                throw error;
            }
            // Embedding endpoint unavailable/failed: degrade gracefully
            const isDebug =
                this.debug ??
                (typeof process !== "undefined" &&
                    (process.env.AKKCO_EMBEDDING_DEBUG === "true" ||
                        process.env.AKKCO_DEBUG === "true"));

            if (this.onDiagnostic || isDebug) {
                const rawMsg = error instanceof Error ? error.message : String(error);
                const sanitized = rawMsg.replace(/[a-zA-Z0-9_-]{20,}/g, "[REDACTED]");
                const diag: MemoryRetrievalDiagnostic = {
                    stage: "query",
                    provider: this.embeddingProvider.id,
                    model: this.embeddingProvider.model,
                    message: sanitized,
                };
                this.onDiagnostic?.(diag);
                if (isDebug) {
                    process.stderr.write(
                        `[embedding-diagnostic] Provider "${diag.provider}" (${diag.model}) query failed: ${sanitized}\n`,
                    );
                }
            }
            return null;
        }
    };

    /**
     * Semantic memory search entrypoint that queries the conversation store for relevant
     * past turns and ranks them by cosine similarity.
     */
    retrieve = async (
        options: ConversationMemoryRetrieveOptions,
    ): Promise<ConversationMemoryCandidate[]> => {
        if (options.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        let queryEmbedding = options.queryEmbedding;
        if (!queryEmbedding && options.queryText) {
            queryEmbedding =
                (await this.embedQuery(options.queryText, options.signal)) ?? undefined;
        }

        if (!queryEmbedding) {
            return [];
        }

        try {
            const candidates = await this.store.searchMemory({
                vector: queryEmbedding.vector,
                identity: queryEmbedding.identity,
                sessionId: options.sessionId,
                excludeSequenceRange: options.excludeSequenceRange,
                limit: options.limit ?? 50,
            });

            return candidates.map((cand: MemoryCandidate) => ({
                document: cand.document,
                similarity: cand.similarity,
                estimatedTokens: estimateTokens(cand.document.content),
            }));
        } catch (error) {
            if (
                options.signal?.aborted ||
                (error instanceof Error && error.name === "AbortError")
            ) {
                throw error;
            }
            // Storage search unavailable: degrade gracefully
            return [];
        }
    };
}
