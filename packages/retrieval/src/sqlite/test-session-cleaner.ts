import { copyFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

export interface IdentifiedTestSession {
    readonly id: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly reason: string;
    readonly samplePrompt?: string;
    readonly transcriptCount: number;
}

export interface TestSessionScanReport {
    readonly dbPath: string;
    readonly totalSessions: number;
    readonly testSessions: readonly IdentifiedTestSession[];
    readonly userSessionsCount: number;
}

export interface CleanupResult {
    readonly backupPath: string;
    readonly deletedSessions: number;
    readonly deletedTranscripts: number;
    readonly deletedMemories: number;
    readonly deletedSummaries: number;
}

const TEST_PROMPT_PATTERNS = [
    "__TEST_WAIT__",
    "__TEST_LONG__",
    "__TEST_TOOL__",
    "__TEST_LONG_WAIT__",
];

const TEST_RESPONSE_PATTERNS = [
    "Line 01: Deterministic history output for scrolling test.",
    "Hello from Akkco deterministic provider.",
    "Starting wait task...",
    "Deterministic response",
];

/**
 * Checks whether the transcript records of a session match verifiable automated test signatures.
 */
const evaluateTestEvidence = (
    records: readonly { type: string; payload: string }[],
): { isTest: boolean; reason: string; samplePrompt?: string } => {
    let samplePrompt: string | undefined;

    for (const record of records) {
        let content = "";
        try {
            const parsed = JSON.parse(record.payload);
            content = typeof parsed?.content === "string" ? parsed.content : "";
            if (record.type === "user" && content && !samplePrompt) {
                samplePrompt = content;
            }
        } catch {
            content = record.payload;
        }

        // 1. Explicit automated test prompt markers
        for (const marker of TEST_PROMPT_PATTERNS) {
            if (content.includes(marker)) {
                return {
                    isTest: true,
                    reason: `Contains test prompt marker: "${marker}"`,
                    samplePrompt,
                };
            }
        }

        // 2. Deterministic test provider canned response patterns
        for (const pattern of TEST_RESPONSE_PATTERNS) {
            if (content.includes(pattern)) {
                return {
                    isTest: true,
                    reason: `Contains DeterministicTestProvider canned response: "${pattern}"`,
                    samplePrompt,
                };
            }
        }

        // 3. Automated CLI unit test mock patterns
        if (
            record.payload.includes('"callId":"call_test_list"') ||
            record.payload.includes('"callId":"read-call"') ||
            (record.payload.includes('"arguments":{"path":"apps/cli/package.json"}') &&
                (record.payload.includes("inspect CLI") ||
                    record.payload.includes("inspect the CLI") ||
                    record.payload.includes("run tool loop")))
        ) {
            return {
                isTest: true,
                reason: "Matches automated CLI tool loop mock test signature",
                samplePrompt,
            };
        }

        if (
            (content === "first turn" || content === "second turn") &&
            records.some((r) => r.payload.includes("slow response"))
        ) {
            return {
                isTest: true,
                reason: "Matches CLI SIGINT cancellation test turn sequence",
                samplePrompt,
            };
        }

        if (content === "first line\nsecond line\nthird line") {
            return {
                isTest: true,
                reason: "Matches CLI bracketed multiline paste test input",
                samplePrompt,
            };
        }

        if (content === "inspect CLI" || content === "inspect the CLI") {
            return {
                isTest: true,
                reason: "Matches CLI tool inspect test input",
                samplePrompt,
            };
        }

        if (
            (content === "first" || content === "second" || content === "third") &&
            records.some(
                (r) =>
                    r.payload.includes("response 1") ||
                    r.payload.includes("response 2") ||
                    r.payload.includes("response 3"),
            )
        ) {
            return {
                isTest: true,
                reason: "Matches CLI piped turn queue test sequence",
                samplePrompt,
            };
        }
    }

    return { isTest: false, reason: "", samplePrompt };
};

/**
 * Scans an existing SQLite database and identifies sessions matching verifiable automated test evidence.
 */
export const scanForTestSessions = async (dbPath: string): Promise<TestSessionScanReport> => {
    const db = new DatabaseSync(dbPath);

    try {
        const sessions = db
            .prepare(
                `
            SELECT id, created_at, updated_at
            FROM sessions
            ORDER BY created_at ASC
        `,
            )
            .all() as Array<{ id: string; created_at: string; updated_at: string }>;

        const transcriptStmt = db.prepare(`
            SELECT type, payload
            FROM transcript_items
            WHERE session_id = ?
            ORDER BY sequence ASC
        `);

        const testSessions: IdentifiedTestSession[] = [];

        for (const session of sessions) {
            const records = transcriptStmt.all(session.id) as Array<{
                type: string;
                payload: string;
            }>;
            const evidence = evaluateTestEvidence(records);

            if (evidence.isTest) {
                testSessions.push({
                    id: session.id,
                    createdAt: session.created_at,
                    updatedAt: session.updated_at,
                    reason: evidence.reason,
                    samplePrompt: evidence.samplePrompt,
                    transcriptCount: records.length,
                });
            }
        }

        return {
            dbPath,
            totalSessions: sessions.length,
            testSessions,
            userSessionsCount: sessions.length - testSessions.length,
        };
    } finally {
        db.close();
    }
};

/**
 * Creates a timestamped backup copy of a persistent SQLite database.
 */
export const createDatabaseBackup = async (dbPath: string): Promise<string> => {
    const backupPath = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(dbPath, backupPath);

    // Also copy WAL sidecar if present
    try {
        await copyFile(`${dbPath}-wal`, `${backupPath}-wal`);
    } catch {
        // WAL file may not exist
    }

    const info = await stat(backupPath);
    if (info.size === 0) {
        throw new Error(`Failed to create backup: backup file "${backupPath}" is empty.`);
    }

    return backupPath;
};

/**
 * Transactionally deletes the specified session IDs from SQLite, removing transcripts,
 * vector memories, context summaries, and session rows after creating a safety backup.
 */
export const cleanupTestSessions = async (
    dbPath: string,
    sessionIdsToDelete: readonly string[],
    options: { backup?: boolean } = {},
): Promise<CleanupResult> => {
    if (sessionIdsToDelete.length === 0) {
        return {
            backupPath: "",
            deletedSessions: 0,
            deletedTranscripts: 0,
            deletedMemories: 0,
            deletedSummaries: 0,
        };
    }

    let backupPath = "";
    if (options.backup !== false && dbPath !== ":memory:") {
        backupPath = await createDatabaseBackup(dbPath);
    }

    const db = new DatabaseSync(dbPath);

    db.exec("BEGIN TRANSACTION;");
    try {
        let deletedMemories = 0;
        let deletedTranscripts = 0;
        let deletedSummaries = 0;
        let deletedSessions = 0;

        const deleteMemoriesStmt = db.prepare("DELETE FROM memory_documents WHERE session_id = ?");
        const deleteTranscriptsStmt = db.prepare(
            "DELETE FROM transcript_items WHERE session_id = ?",
        );
        const deleteSummariesStmt = db.prepare(
            "DELETE FROM context_summaries WHERE session_id = ?",
        );
        const deleteSessionStmt = db.prepare("DELETE FROM sessions WHERE id = ?");

        for (const sessionId of sessionIdsToDelete) {
            const r1 = deleteMemoriesStmt.run(sessionId);
            deletedMemories += Number(r1.changes ?? 0);

            const r2 = deleteTranscriptsStmt.run(sessionId);
            deletedTranscripts += Number(r2.changes ?? 0);

            const r3 = deleteSummariesStmt.run(sessionId);
            deletedSummaries += Number(r3.changes ?? 0);

            const r4 = deleteSessionStmt.run(sessionId);
            deletedSessions += Number(r4.changes ?? 0);
        }

        db.exec("COMMIT;");
        db.close();

        return {
            backupPath,
            deletedSessions,
            deletedTranscripts,
            deletedMemories,
            deletedSummaries,
        };
    } catch (error) {
        try {
            db.exec("ROLLBACK;");
        } catch {}
        try {
            db.close();
        } catch {}
        throw error;
    }
};
