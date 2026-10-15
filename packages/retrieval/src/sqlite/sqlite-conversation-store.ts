import "./suppress-warning.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
    ConversationStore,
    MemoryCandidate,
    MemoryDocumentInput,
    MemorySearchQuery,
    StoredMemoryDocument,
    StoredSession,
    StoredTranscriptRecord,
} from "../types.js";
import { cosineSimilarity } from "./cosine.js";
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from "./migrations.js";
import { deserializeVector, serializeVector } from "./vector-serializer.js";

export interface SqliteConversationStoreOptions {
    dbPath: string;
    migrationsDir?: string;
}

export class SqliteConversationStore implements ConversationStore {
    private db: DatabaseSync | null = null;
    private initPromise: Promise<void> | null = null;
    private readonly dbPath: string;
    private readonly migrationsDir?: string;

    constructor(options: SqliteConversationStoreOptions) {
        this.dbPath = options.dbPath;
        this.migrationsDir = options.migrationsDir;
    }

    private getDb = (): DatabaseSync => {
        if (!this.db) {
            throw new Error("SqliteConversationStore is not initialized. Call initialize() first.");
        }
        return this.db;
    };

    initialize = async (): Promise<void> => {
        if (this.db) {
            return;
        }

        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            if (this.dbPath !== ":memory:") {
                await mkdir(dirname(this.dbPath), { recursive: true });
            }

            const db = new DatabaseSync(this.dbPath, {
                enableForeignKeyConstraints: true,
            });

            db.exec("PRAGMA foreign_keys = ON;");
            db.exec("PRAGMA busy_timeout = 3000;");

            try {
                await migrateDatabase(db, { migrationsDir: this.migrationsDir });
                this.db = db;
            } catch (error) {
                try {
                    db.close();
                } catch {}
                throw error;
            } finally {
                this.initPromise = null;
            }
        })();

        return this.initPromise;
    };

    close = async (): Promise<void> => {
        if (this.initPromise) {
            try {
                await this.initPromise;
            } catch {}
        }
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    };

    getSchemaVersion = async (): Promise<number> => {
        const db = this.getDb();
        const row = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as
            { version: number | null } | undefined;
        return row?.version ?? CURRENT_SCHEMA_VERSION;
    };

    saveSession = async (session: {
        id: string;
        createdAt?: string;
        updatedAt?: string;
    }): Promise<void> => {
        const db = this.getDb();
        const now = new Date().toISOString();
        const stmt = db.prepare(`
            INSERT INTO sessions (id, created_at, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
        `);
        stmt.run(session.id, session.createdAt ?? now, session.updatedAt ?? now);
    };

    getSession = async (sessionId: string): Promise<StoredSession | null> => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT id, created_at, updated_at FROM sessions WHERE id = ?");
        const row = stmt.get(sessionId) as
            { id: string; created_at: string; updated_at: string } | undefined;

        if (!row) {
            return null;
        }

        return {
            id: row.id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    };

    hasSession = async (sessionId: string): Promise<boolean> => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT 1 FROM sessions WHERE id = ?");
        return Boolean(stmt.get(sessionId));
    };

    saveTranscriptItems = async (
        sessionId: string,
        items: readonly {
            id?: string;
            sequence: number;
            type: string;
            payload: string;
            createdAt?: string;
        }[],
    ): Promise<void> => {
        if (items.length === 0) {
            return;
        }

        const db = this.getDb();
        await this.saveSession({ id: sessionId });

        db.exec("BEGIN IMMEDIATE");
        try {
            const checkStmt = db.prepare(`
                SELECT type, payload FROM transcript_items
                WHERE session_id = ? AND sequence = ?
            `);
            const insertStmt = db.prepare(`
                INSERT INTO transcript_items (id, session_id, sequence, type, payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);

            const now = new Date().toISOString();
            for (const item of items) {
                const existing = checkStmt.get(sessionId, item.sequence) as
                    { type: string; payload: string } | undefined;

                if (existing) {
                    if (existing.type !== item.type || existing.payload !== item.payload) {
                        throw new Error(
                            `Transcript conflict in session "${sessionId}" at sequence ${item.sequence}: conflicting non-identical record`,
                        );
                    }
                    // Identical payload: idempotent retry, preserve existing record
                    continue;
                }

                const id = item.id ?? `${sessionId}:${item.sequence}`;
                insertStmt.run(
                    id,
                    sessionId,
                    item.sequence,
                    item.type,
                    item.payload,
                    item.createdAt ?? now,
                );
            }

            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    };

    getTranscriptItems = async (sessionId: string): Promise<StoredTranscriptRecord[]> => {
        const db = this.getDb();
        const stmt = db.prepare(
            "SELECT id, session_id, sequence, type, payload, created_at FROM transcript_items WHERE session_id = ? ORDER BY sequence ASC",
        );
        const rows = stmt.all(sessionId) as Array<{
            id: string;
            session_id: string;
            sequence: number;
            type: string;
            payload: string;
            created_at: string;
        }>;

        return rows.map((row) => ({
            id: row.id,
            sessionId: row.session_id,
            sequence: row.sequence,
            type: row.type,
            payload: row.payload,
            createdAt: row.created_at,
        }));
    };

    saveMemoryDocument = async (doc: MemoryDocumentInput): Promise<void> => {
        await this.saveMemoryDocuments([doc]);
    };

    saveMemoryDocuments = async (docs: readonly MemoryDocumentInput[]): Promise<void> => {
        if (docs.length === 0) {
            return;
        }

        const db = this.getDb();
        const now = new Date().toISOString();

        for (const doc of docs) {
            await this.saveSession({ id: doc.sessionId });
        }

        db.exec("BEGIN");
        try {
            const stmt = db.prepare(`
                INSERT INTO memory_documents (
                    id, session_id, start_sequence, end_sequence,
                    content, embedding, embedding_provider,
                    embedding_model, embedding_dimensions, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    content = excluded.content,
                    embedding = excluded.embedding,
                    embedding_provider = excluded.embedding_provider,
                    embedding_model = excluded.embedding_model,
                    embedding_dimensions = excluded.embedding_dimensions,
                    created_at = excluded.created_at
            `);

            for (const doc of docs) {
                const id = doc.id ?? `${doc.sessionId}:${doc.startSequence}-${doc.endSequence}`;
                const serialized = serializeVector(doc.embedding);

                stmt.run(
                    id,
                    doc.sessionId,
                    doc.startSequence,
                    doc.endSequence,
                    doc.content,
                    serialized,
                    doc.embeddingProvider,
                    doc.embeddingModel,
                    doc.embedding.length,
                    doc.createdAt ?? now,
                );
            }

            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    };

    searchMemory = async (query: MemorySearchQuery): Promise<MemoryCandidate[]> => {
        const db = this.getDb();
        const dimensions = query.identity.dimensions ?? query.vector.length;

        let sql = `
            SELECT id, session_id, start_sequence, end_sequence, content,
                   embedding, embedding_provider, embedding_model, embedding_dimensions, created_at
            FROM memory_documents
            WHERE embedding_provider = ?
              AND embedding_model = ?
              AND embedding_dimensions = ?
        `;
        const params: (string | number)[] = [
            query.identity.provider,
            query.identity.model,
            dimensions,
        ];

        if (query.sessionId) {
            sql += " AND session_id = ?";
            params.push(query.sessionId);
        }

        if (query.excludeSessionId) {
            sql += " AND session_id != ?";
            params.push(query.excludeSessionId);
        }

        const stmt = db.prepare(sql);
        const rows = stmt.all(...params) as Array<{
            id: string;
            session_id: string;
            start_sequence: number;
            end_sequence: number;
            content: string;
            embedding: Uint8Array;
            embedding_provider: string;
            embedding_model: string;
            embedding_dimensions: number;
            created_at: string;
        }>;

        const candidates: MemoryCandidate[] = [];

        for (const row of rows) {
            if (
                query.excludeSequenceRange &&
                query.sessionId &&
                row.session_id === query.sessionId
            ) {
                const overlaps = !(
                    row.end_sequence < query.excludeSequenceRange.start ||
                    row.start_sequence > query.excludeSequenceRange.end
                );
                if (overlaps) {
                    continue;
                }
            }

            let candidateVector: number[];
            try {
                candidateVector = deserializeVector(row.embedding, row.embedding_dimensions);
            } catch {
                // Isolate corrupt or invalid persisted vector so it does not disable retrieval of other valid memories
                continue;
            }
            const similarity = cosineSimilarity(query.vector, candidateVector);

            if (similarity <= 0) {
                continue;
            }

            if (query.minSimilarity !== undefined && similarity < query.minSimilarity) {
                continue;
            }

            candidates.push({
                document: {
                    id: row.id,
                    sessionId: row.session_id,
                    startSequence: row.start_sequence,
                    endSequence: row.end_sequence,
                    content: row.content,
                    embeddingProvider: row.embedding_provider,
                    embeddingModel: row.embedding_model,
                    embeddingDimensions: row.embedding_dimensions,
                    createdAt: row.created_at,
                },
                similarity,
            });
        }

        candidates.sort((a, b) => b.similarity - a.similarity);

        const limit = query.limit ?? 50;
        return candidates.slice(0, limit);
    };

    getMemoryDocuments = async (sessionId: string): Promise<StoredMemoryDocument[]> => {
        const db = this.getDb();
        const stmt = db.prepare(`
            SELECT id, session_id, start_sequence, end_sequence, content,
                   embedding_provider, embedding_model, embedding_dimensions, created_at
            FROM memory_documents
            WHERE session_id = ?
            ORDER BY start_sequence ASC
        `);
        const rows = stmt.all(sessionId) as Array<{
            id: string;
            session_id: string;
            start_sequence: number;
            end_sequence: number;
            content: string;
            embedding_provider: string;
            embedding_model: string;
            embedding_dimensions: number;
            created_at: string;
        }>;

        return rows.map((row) => ({
            id: row.id,
            sessionId: row.session_id,
            startSequence: row.start_sequence,
            endSequence: row.end_sequence,
            content: row.content,
            embeddingProvider: row.embedding_provider,
            embeddingModel: row.embedding_model,
            embeddingDimensions: row.embedding_dimensions,
            createdAt: row.created_at,
        }));
    };
}
