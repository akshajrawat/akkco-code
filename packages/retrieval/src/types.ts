import type { EmbeddingIdentity } from "@akkco/models";

export interface StoredSession {
    readonly id: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface StoredTranscriptRecord {
    readonly id: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly type: string;
    readonly payload: string;
    readonly createdAt: string;
}

export interface StoredMemoryDocument {
    readonly id: string;
    readonly sessionId: string;
    readonly startSequence: number;
    readonly endSequence: number;
    readonly content: string;
    readonly embeddingProvider: string;
    readonly embeddingModel: string;
    readonly embeddingDimensions: number;
    readonly createdAt: string;
}

export interface MemoryDocumentInput {
    readonly id?: string;
    readonly sessionId: string;
    readonly startSequence: number;
    readonly endSequence: number;
    readonly content: string;
    readonly embedding: readonly number[];
    readonly embeddingProvider: string;
    readonly embeddingModel: string;
    readonly createdAt?: string;
}

export interface MemorySearchQuery {
    readonly vector: readonly number[];
    readonly identity: EmbeddingIdentity;
    readonly sessionId?: string;
    readonly excludeSessionId?: string;
    readonly excludeSequenceRange?: {
        readonly start: number;
        readonly end: number;
    };
    readonly limit?: number;
    readonly minSimilarity?: number;
}

export interface MemoryCandidate {
    readonly document: StoredMemoryDocument;
    readonly similarity: number;
}

export interface ConversationStore {
    initialize(): Promise<void>;
    close(): Promise<void>;
    getSchemaVersion(): Promise<number>;

    saveSession(session: { id: string; createdAt?: string; updatedAt?: string }): Promise<void>;
    getSession(sessionId: string): Promise<StoredSession | null>;
    hasSession(sessionId: string): Promise<boolean>;

    saveTranscriptItems(
        sessionId: string,
        items: readonly {
            id?: string;
            sequence: number;
            type: string;
            payload: string;
            createdAt?: string;
        }[],
    ): Promise<void>;
    getTranscriptItems(sessionId: string): Promise<StoredTranscriptRecord[]>;

    saveMemoryDocument(doc: MemoryDocumentInput): Promise<void>;
    saveMemoryDocuments(docs: readonly MemoryDocumentInput[]): Promise<void>;
    searchMemory(query: MemorySearchQuery): Promise<MemoryCandidate[]>;
    getMemoryDocuments(sessionId: string): Promise<StoredMemoryDocument[]>;
}
