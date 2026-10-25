import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

export interface IdentifiedTestSession {
    readonly id: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly reason: string;
    readonly samplePrompt?: string;
    readonly transcriptCount: number;
    readonly isProbable?: boolean;
    readonly deletionAuthorized?: boolean;
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
    readonly skippedSessions?: readonly string[];
}

export interface TestEvidenceEvaluation {
    readonly isProbableTest: boolean;
    readonly isAuthorizedForDeletion: boolean;
    readonly reason: string;
    readonly samplePrompt?: string;
}

const TEST_DIRECTIVE_PATTERNS = [
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

const isTestDirective = (content: string): string | null => {
    const trimmed = content.trim();
    for (const marker of TEST_DIRECTIVE_PATTERNS) {
        if (
            trimmed === marker ||
            trimmed.startsWith(`${marker} `) ||
            trimmed.startsWith(`${marker}\n`)
        ) {
            return marker;
        }
    }
    return null;
};

const isKnownTestUserInput = (
    content: string,
    allRecords: readonly { type: string; payload: string }[],
): boolean => {
    if (isTestDirective(content)) {
        return true;
    }
    if (content === "first line\nsecond line\nthird line") {
        return true;
    }
    if (
        (content === "first turn" || content === "second turn") &&
        allRecords.some((r) => r.payload.includes("slow response"))
    ) {
        return true;
    }
    if (
        (content === "first" || content === "second" || content === "third") &&
        allRecords.some(
            (r) =>
                r.payload.includes("response 1") ||
                r.payload.includes("response 2") ||
                r.payload.includes("response 3"),
        )
    ) {
        return true;
    }
    if (
        content === "Hello" &&
        allRecords.some((r) => r.payload.includes("Hello from Akkco deterministic provider."))
    ) {
        return true;
    }
    return false;
};

/**
 * Checks whether the transcript records of a session match verifiable automated test signatures.
 * Separates probable test detection from deletion authorization:
 * - Generic prompts such as "inspect CLI" or mentions of "__TEST_WAIT__" are explicitly rejected
 *   as sufficient evidence to authorize deletion.
 * - Deletion authorization requires verifiable test provider output, mock call IDs, or strict test directives.
 * - Mixed-content sessions (sessions containing legitimate user conversation alongside test records)
 *   strictly fail closed to prevent data loss.
 */
export const evaluateTestEvidence = (
    records: readonly { type: string; payload: string }[],
): TestEvidenceEvaluation => {
    let samplePrompt: string | undefined;
    let testEvidenceReason: string | undefined;
    let hasLegitimateUserContent = false;

    for (const record of records) {
        let content = "";
        let recordType = record.type;
        try {
            const parsed = JSON.parse(record.payload);
            content = typeof parsed?.content === "string" ? parsed.content : "";
            if (typeof parsed?.type === "string") {
                recordType = parsed.type;
            }
            if (recordType === "user" && content && !samplePrompt) {
                samplePrompt = content;
            }
        } catch {
            content = record.payload;
        }

        // Check if this user turn is a legitimate non-test conversation
        if (recordType === "user" && content.trim()) {
            if (!isKnownTestUserInput(content, records)) {
                hasLegitimateUserContent = true;
            }
        }

        // 1. Verifiable DeterministicTestProvider canned responses (authoritative test evidence)
        for (const pattern of TEST_RESPONSE_PATTERNS) {
            if (content.includes(pattern)) {
                testEvidenceReason = `Contains DeterministicTestProvider canned response: "${pattern}"`;
                break;
            }
        }

        // 2. Automated CLI unit test mock tool call IDs (authoritative test harness signatures)
        if (
            record.payload.includes('"callId":"call_test_list"') ||
            record.payload.includes('"callId":"read-call"')
        ) {
            testEvidenceReason = "Matches automated CLI mock tool call signature";
        }

        // 3. Automated CLI multi-turn test sequences
        if (
            (content === "first turn" || content === "second turn") &&
            records.some((r) => r.payload.includes("slow response"))
        ) {
            testEvidenceReason = "Matches CLI SIGINT cancellation test turn sequence";
        }

        if (
            content === "first line\nsecond line\nthird line" &&
            records.some((r) => r.type === "assistant")
        ) {
            testEvidenceReason = "Matches CLI bracketed multiline paste test input";
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
            testEvidenceReason = "Matches CLI piped turn queue test sequence";
        }

        // 4. Test directive commands: Must strictly start with or equal the directive.
        const matchedDirective = isTestDirective(content);
        if (matchedDirective) {
            testEvidenceReason ??= `Matches automated test harness directive: "${matchedDirective}"`;
        }
    }

    // Fail-closed rule for mixed-content sessions:
    // If a session has legitimate user conversation, it must NEVER be deleted,
    // even if older records in the session matched test signatures.
    if (hasLegitimateUserContent) {
        if (testEvidenceReason) {
            return {
                isProbableTest: false,
                isAuthorizedForDeletion: false,
                reason: "Mixed-content session: contains legitimate user conversation alongside test records (fails closed to prevent data loss)",
                samplePrompt,
            };
        }
        return {
            isProbableTest: false,
            isAuthorizedForDeletion: false,
            reason: "",
            samplePrompt,
        };
    }

    // Pure test session with verified test evidence
    if (testEvidenceReason) {
        return {
            isProbableTest: true,
            isAuthorizedForDeletion: true,
            reason: testEvidenceReason,
            samplePrompt,
        };
    }

    return {
        isProbableTest: false,
        isAuthorizedForDeletion: false,
        reason: "",
        samplePrompt,
    };
};

/**
 * Validates the SQLite database integrity of a file, verifying that it is non-empty
 * and passes SQLite's PRAGMA integrity_check.
 */
export const validateDatabaseIntegrity = async (dbPath: string): Promise<boolean> => {
    const info = await stat(dbPath);
    if (info.size === 0) {
        throw new Error(`Database validation failed: file "${dbPath}" is empty.`);
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const rows = db.prepare("PRAGMA integrity_check;").all() as Array<{
            integrity_check: string;
        }>;
        const isOk = rows.length === 1 && rows[0].integrity_check === "ok";
        if (!isOk) {
            throw new Error(
                `Database integrity check failed for "${dbPath}": ${JSON.stringify(rows)}`,
            );
        }
        return true;
    } finally {
        db.close();
    }
};

/**
 * Creates a SQLite-consistent snapshot backup of a persistent database using SQLite's VACUUM INTO,
 * and validates the backup's integrity before returning.
 */
export const createDatabaseBackup = async (dbPath: string): Promise<string> => {
    const backupPath = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const escaped = backupPath.replace(/'/g, "''");
        db.exec(`VACUUM INTO '${escaped}';`);
    } finally {
        db.close();
    }

    // Validate backup integrity before authorizing any deletions
    await validateDatabaseIntegrity(backupPath);

    return backupPath;
};

/**
 * Scans an existing SQLite database and identifies sessions matching verifiable automated test evidence.
 */
export const scanForTestSessions = async (dbPath: string): Promise<TestSessionScanReport> => {
    const db = new DatabaseSync(dbPath, { readOnly: true });

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

            if (evidence.isProbableTest) {
                testSessions.push({
                    id: session.id,
                    createdAt: session.created_at,
                    updatedAt: session.updated_at,
                    reason: evidence.reason,
                    samplePrompt: evidence.samplePrompt,
                    transcriptCount: records.length,
                    isProbable: true,
                    deletionAuthorized: evidence.isAuthorizedForDeletion,
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
 * Transactionally deletes the specified session IDs from SQLite, removing transcripts,
 * vector memories, context summaries, and session rows after creating a safety backup.
 * Revalidates selected records immediately before deletion inside the transaction to prevent
 * stale scan results from causing data loss.
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
            skippedSessions: [],
        };
    }

    let backupPath = "";
    if (options.backup !== false && dbPath !== ":memory:") {
        backupPath = await createDatabaseBackup(dbPath);
    }

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 3000;");

    db.exec("BEGIN IMMEDIATE;");
    try {
        let deletedMemories = 0;
        let deletedTranscripts = 0;
        let deletedSummaries = 0;
        let deletedSessions = 0;
        const skippedSessions: string[] = [];

        const sessionCheckStmt = db.prepare("SELECT id FROM sessions WHERE id = ?");
        const transcriptStmt = db.prepare(`
            SELECT type, payload
            FROM transcript_items
            WHERE session_id = ?
            ORDER BY sequence ASC
        `);

        const deleteMemoriesStmt = db.prepare("DELETE FROM memory_documents WHERE session_id = ?");
        const deleteTranscriptsStmt = db.prepare(
            "DELETE FROM transcript_items WHERE session_id = ?",
        );
        const deleteSummariesStmt = db.prepare(
            "DELETE FROM context_summaries WHERE session_id = ?",
        );
        const deleteSessionStmt = db.prepare("DELETE FROM sessions WHERE id = ?");

        for (const sessionId of sessionIdsToDelete) {
            const sessionRow = sessionCheckStmt.get(sessionId);
            if (!sessionRow) {
                skippedSessions.push(sessionId);
                continue;
            }

            // Revalidate selected records immediately before deletion to prevent stale scan results
            const records = transcriptStmt.all(sessionId) as Array<{
                type: string;
                payload: string;
            }>;
            const evidence = evaluateTestEvidence(records);

            if (!evidence.isAuthorizedForDeletion) {
                skippedSessions.push(sessionId);
                continue;
            }

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
            skippedSessions,
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
