import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    cleanupTestSessions,
    createDatabaseBackup,
    scanForTestSessions,
    validateDatabaseIntegrity,
    SqliteConversationStore,
} from "../src/index.js";

test("testSessionCleaner: scans and identifies test sessions while preserving real user sessions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cleaner-test-"));
    const dbPath = path.join(tempDir, "test.db");

    const store = new SqliteConversationStore({ dbPath });
    await store.initialize();

    // 1. Real user session 1
    const userSess1 = "user-sess-1111-2222-3333-4444";
    await store.saveSession({ id: userSess1 });
    await store.saveTranscriptItems(userSess1, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({
                type: "user",
                content: "Can you help me refactor my auth module?",
            }),
        },
        {
            sequence: 1,
            type: "assistant",
            payload: JSON.stringify({
                type: "assistant",
                content: "Sure, let's look at auth.ts",
                status: "completed",
            }),
        },
    ]);

    // 2. Real user session 2 with custom name
    const userSess2 = "custom-project-planning";
    await store.saveSession({ id: userSess2 });
    await store.saveTranscriptItems(userSess2, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "What database should we choose?" }),
        },
    ]);

    // 3. Automated test session with __TEST_WAIT__
    const testSess1 = "session-1791542880001";
    await store.saveSession({ id: testSess1 });
    await store.saveTranscriptItems(testSess1, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "__TEST_WAIT__" }),
        },
        {
            sequence: 1,
            type: "assistant",
            payload: JSON.stringify({
                type: "assistant",
                content: "Starting wait task...",
                status: "interrupted",
            }),
        },
    ]);

    // 4. Automated test session with __TEST_LONG__
    const testSess2 = "session-1791542880002";
    await store.saveSession({ id: testSess2 });
    await store.saveTranscriptItems(testSess2, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "__TEST_LONG__ first" }),
        },
    ]);

    // 5. Automated test session with canned deterministic provider string
    const testSess3 = "session-1791542880003";
    await store.saveSession({ id: testSess3 });
    await store.saveTranscriptItems(testSess3, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "Hello" }),
        },
        {
            sequence: 1,
            type: "assistant",
            payload: JSON.stringify({
                type: "assistant",
                content: "Hello from Akkco deterministic provider.",
                status: "completed",
            }),
        },
    ]);

    // Add some memory documents and summaries
    await store.saveMemoryDocument({
        sessionId: userSess1,
        startSequence: 0,
        endSequence: 1,
        content: "Auth module discussion",
        embedding: new Array(768).fill(0.1),
        embeddingProvider: "gemini",
        embeddingModel: "gemini-embedding-001",
    });
    await store.saveMemoryDocument({
        sessionId: testSess1,
        startSequence: 0,
        endSequence: 1,
        content: "Test wait document",
        embedding: new Array(768).fill(0.2),
        embeddingProvider: "gemini",
        embeddingModel: "gemini-embedding-001",
    });

    await store.close();

    try {
        // Run scan
        const report = await scanForTestSessions(dbPath);
        assert.equal(report.totalSessions, 5);
        assert.equal(report.testSessions.length, 3);
        assert.equal(report.userSessionsCount, 2);

        const testIds = report.testSessions.map((s) => s.id);
        assert.ok(testIds.includes(testSess1));
        assert.ok(testIds.includes(testSess2));
        assert.ok(testIds.includes(testSess3));
        assert.ok(!testIds.includes(userSess1));
        assert.ok(!testIds.includes(userSess2));

        // Test database backup creation using SQLite-consistent snapshot
        const backupPath = await createDatabaseBackup(dbPath);
        assert.ok(backupPath.includes(".backup-"));
        const isValid = await validateDatabaseIntegrity(backupPath);
        assert.equal(isValid, true);

        // Transactional cleanup of test sessions
        const result = await cleanupTestSessions(dbPath, testIds, { backup: false });
        assert.equal(result.deletedSessions, 3);
        assert.equal(result.deletedTranscripts, 5);
        assert.equal(result.deletedMemories, 1);

        // Re-open and verify database state
        const verifyStore = new SqliteConversationStore({ dbPath });
        await verifyStore.initialize();

        const remainingSessions = await verifyStore.listSessions();
        assert.equal(remainingSessions.length, 2);
        assert.equal(
            remainingSessions.some((s) => s.id === userSess1),
            true,
        );
        assert.equal(
            remainingSessions.some((s) => s.id === userSess2),
            true,
        );
        assert.equal(
            remainingSessions.some((s) => testIds.includes(s.id)),
            false,
        );

        // User session transcript items remain intact
        const userItems = await verifyStore.getTranscriptItems(userSess1);
        assert.equal(userItems.length, 2);

        // User session memory document remains intact
        const userDocs = await verifyStore.getMemoryDocuments(userSess1);
        assert.equal(userDocs.length, 1);
        assert.equal(userDocs[0].content, "Auth module discussion");

        await verifyStore.close();
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("testSessionCleaner safety: generic prompts and mentions of __TEST_WAIT__ are NOT sufficient evidence to delete", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cleaner-safety-test-"));
    const dbPath = path.join(tempDir, "safety.db");

    const store = new SqliteConversationStore({ dbPath });
    await store.initialize();

    // 1. Session with generic prompt "inspect CLI"
    const genericPromptSess = "user-sess-inspect-cli";
    await store.saveSession({ id: genericPromptSess });
    await store.saveTranscriptItems(genericPromptSess, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "inspect CLI" }),
        },
        {
            sequence: 1,
            type: "assistant",
            payload: JSON.stringify({
                type: "assistant",
                content: "Here is the structure of the apps/cli directory...",
                status: "completed",
            }),
        },
    ]);

    // 2. Session mentioning __TEST_WAIT__ in conversation
    const mentionTestWaitSess = "user-sess-mentioning-test-wait";
    await store.saveSession({ id: mentionTestWaitSess });
    await store.saveTranscriptItems(mentionTestWaitSess, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({
                type: "user",
                content: "Can you explain how __TEST_WAIT__ is handled in test-provider.ts?",
            }),
        },
        {
            sequence: 1,
            type: "assistant",
            payload: JSON.stringify({
                type: "assistant",
                content: "The __TEST_WAIT__ flag signals deterministic delay in tests...",
                status: "completed",
            }),
        },
    ]);

    // 3. Genuine automated test session
    const genuineTestSess = "genuine-test-session";
    await store.saveSession({ id: genuineTestSess });
    await store.saveTranscriptItems(genuineTestSess, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "__TEST_WAIT__" }),
        },
        {
            sequence: 1,
            type: "assistant",
            payload: JSON.stringify({
                type: "assistant",
                content: "Starting wait task...",
                status: "interrupted",
            }),
        },
    ]);

    await store.close();

    try {
        // Scan must NOT classify generic prompts or mentions of __TEST_WAIT__ as test sessions
        const report = await scanForTestSessions(dbPath);
        assert.equal(report.totalSessions, 3);
        assert.equal(report.testSessions.length, 1);
        assert.equal(report.testSessions[0].id, genuineTestSess);
        assert.equal(report.userSessionsCount, 2);

        // Attempting to delete a user session with a generic prompt must be rejected by revalidation
        const staleCleanup = await cleanupTestSessions(dbPath, [genericPromptSess], {
            backup: false,
        });
        assert.equal(staleCleanup.deletedSessions, 0);
        assert.deepEqual(staleCleanup.skippedSessions, [genericPromptSess]);

        // Attempting to delete a user session mentioning __TEST_WAIT__ must be rejected by revalidation
        const mentionCleanup = await cleanupTestSessions(dbPath, [mentionTestWaitSess], {
            backup: false,
        });
        assert.equal(mentionCleanup.deletedSessions, 0);
        assert.deepEqual(mentionCleanup.skippedSessions, [mentionTestWaitSess]);

        // Re-open and verify user sessions are 100% preserved
        const verifyStore = new SqliteConversationStore({ dbPath });
        await verifyStore.initialize();
        const userItems1 = await verifyStore.getTranscriptItems(genericPromptSess);
        assert.equal(userItems1.length, 2);
        const userItems2 = await verifyStore.getTranscriptItems(mentionTestWaitSess);
        assert.equal(userItems2.length, 2);
        await verifyStore.close();
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("testSessionCleaner: revalidation immediately before deletion prevents stale scan deletion of mixed sessions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cleaner-stale-test-"));
    const dbPath = path.join(tempDir, "stale.db");

    const store = new SqliteConversationStore({ dbPath });
    await store.initialize();

    const sessId = "session-stale-revalidation";
    await store.saveSession({ id: sessId });
    await store.saveTranscriptItems(sessId, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "__TEST_WAIT__" }),
        },
    ]);

    // Initial scan identifies it when it only has the automated test directive
    const initialReport = await scanForTestSessions(dbPath);
    assert.equal(initialReport.testSessions.length, 1);
    assert.equal(initialReport.testSessions[0].id, sessId);
    assert.equal(initialReport.testSessions[0].deletionAuthorized, true);

    // Stale modification: Before cleanup is run, the user resumes the session and adds legitimate project turns
    await store.saveTranscriptItems(sessId, [
        {
            sequence: 1,
            type: "user",
            payload: JSON.stringify({
                type: "user",
                content: "Actually, please help me write production code.",
            }),
        },
        {
            sequence: 2,
            type: "assistant",
            payload: JSON.stringify({
                type: "assistant",
                content: "Certainly! Let's proceed with production code.",
                status: "completed",
            }),
        },
    ]);
    await store.close();

    try {
        // Fresh scan must fail-closed on mixed-content sessions
        const freshReport = await scanForTestSessions(dbPath);
        assert.equal(
            freshReport.testSessions.length,
            0,
            "Resumed mixed-content session must not be classified as a test session",
        );
        assert.equal(
            freshReport.userSessionsCount,
            1,
            "Mixed-content session must be counted as a preserved user session",
        );

        // Attempt destructive cleanup using the stale scan result ID
        const result = await cleanupTestSessions(dbPath, [sessId], { backup: false });

        // Assert fail-closed behavior: session was skipped and 0 records were deleted
        assert.equal(result.deletedSessions, 0, "Must not delete mixed-content session");
        assert.equal(
            result.deletedTranscripts,
            0,
            "Must not delete transcripts of mixed-content session",
        );
        assert.deepEqual(
            result.skippedSessions,
            [sessId],
            "Stale session ID must be reported in skippedSessions",
        );

        // Re-open store and verify the resumed session and all its records are 100% intact
        const verifyStore = new SqliteConversationStore({ dbPath });
        await verifyStore.initialize();
        const remaining = await verifyStore.listSessions();
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].id, sessId);

        const items = await verifyStore.getTranscriptItems(sessId);
        assert.equal(items.length, 3, "All 3 transcript items must remain intact");
        const parsed1 = JSON.parse(items[1].payload);
        assert.equal(parsed1.content, "Actually, please help me write production code.");
        const parsed2 = JSON.parse(items[2].payload);
        assert.equal(parsed2.content, "Certainly! Let's proceed with production code.");

        await verifyStore.close();
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
