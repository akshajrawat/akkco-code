import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    cleanupTestSessions,
    createDatabaseBackup,
    scanForTestSessions,
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

        // Test database backup creation
        const backupPath = await createDatabaseBackup(dbPath);
        assert.ok(backupPath.includes(".backup-"));
        const backupStat = await fs.stat(backupPath);
        assert.ok(backupStat.size > 0);

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
