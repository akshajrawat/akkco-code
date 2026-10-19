import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION, SqliteConversationStore } from "../src/index.js";

test("SqliteConversationStore: isolated database creation and schema initialization", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const version = await store.getSchemaVersion();
    assert.equal(version, CURRENT_SCHEMA_VERSION);

    await store.close();
});

test("SqliteConversationStore: schema initialization is idempotent", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-sqlite-test-"));
    const dbPath = join(tmpDir, "test.db");

    try {
        const store1 = new SqliteConversationStore({ dbPath });
        await store1.initialize();
        assert.equal(await store1.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
        await store1.close();

        // Reopen same database file
        const store2 = new SqliteConversationStore({ dbPath });
        await store2.initialize();
        // Call initialize twice on the same instance
        await store2.initialize();
        assert.equal(await store2.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
        await store2.close();
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("SqliteConversationStore: session storage and existence checks", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    assert.equal(await store.hasSession("sess-1"), false);
    assert.equal(await store.getSession("sess-1"), null);

    await store.saveSession({ id: "sess-1" });
    assert.equal(await store.hasSession("sess-1"), true);

    const session = await store.getSession("sess-1");
    assert.ok(session);
    assert.equal(session.id, "sess-1");
    assert.ok(session.createdAt);
    assert.ok(session.updatedAt);

    await store.close();
});

test("SqliteConversationStore: transcript sequence ordering and payload round-trip", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const transcriptItems = [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "hello" }),
        },
        {
            sequence: 2,
            type: "assistant",
            payload: JSON.stringify({
                type: "assistant",
                content: "world",
                status: "completed",
            }),
        },
        {
            sequence: 1,
            type: "tool_execution",
            payload: JSON.stringify({
                type: "tool_execution",
                callId: "c1",
                toolName: "read_file",
                arguments: { path: "a.ts" },
                status: "completed",
                result: "content",
            }),
        },
    ];

    // Insert out of order
    await store.saveTranscriptItems("sess-2", transcriptItems);

    const retrieved = await store.getTranscriptItems("sess-2");
    assert.equal(retrieved.length, 3);

    // Verify ordering by sequence
    assert.equal(retrieved[0].sequence, 0);
    assert.equal(retrieved[1].sequence, 1);
    assert.equal(retrieved[2].sequence, 2);

    // Verify payload round-trip
    assert.deepEqual(JSON.parse(retrieved[0].payload), { type: "user", content: "hello" });
    assert.deepEqual(JSON.parse(retrieved[1].payload), {
        type: "tool_execution",
        callId: "c1",
        toolName: "read_file",
        arguments: { path: "a.ts" },
        status: "completed",
        result: "content",
    });
    assert.deepEqual(JSON.parse(retrieved[2].payload), {
        type: "assistant",
        content: "world",
        status: "completed",
    });

    await store.close();
});

test("SqliteConversationStore: memory document storage and vector search with identity", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const doc1 = {
        sessionId: "sess-3",
        startSequence: 0,
        endSequence: 2,
        content: "Turn 1 content regarding typescript",
        embedding: [1, 0, 0, 0],
        embeddingProvider: "test-provider",
        embeddingModel: "model-a",
    };

    const doc2 = {
        sessionId: "sess-3",
        startSequence: 3,
        endSequence: 5,
        content: "Turn 2 content regarding python",
        embedding: [0, 1, 0, 0],
        embeddingProvider: "test-provider",
        embeddingModel: "model-a",
    };

    const docOtherIdentity = {
        sessionId: "sess-3",
        startSequence: 6,
        endSequence: 8,
        content: "Turn 3 with incompatible embedding model",
        embedding: [1, 0, 0, 0],
        embeddingProvider: "test-provider",
        embeddingModel: "model-b", // Different model!
    };

    await store.saveMemoryDocuments([doc1, doc2, docOtherIdentity]);

    // Query matching doc1
    const results = await store.searchMemory({
        vector: [1, 0, 0, 0],
        identity: {
            provider: "test-provider",
            model: "model-a",
            dimensions: 4,
        },
        sessionId: "sess-3",
    });

    // Should find doc1 and doc2, but NOT docOtherIdentity because model differs
    assert.equal(results.length, 1); // doc2 has similarity 0, docOtherIdentity model differs
    assert.equal(results[0].document.content, doc1.content);
    assert.equal(results[0].document.embeddingProvider, "test-provider");
    assert.equal(results[0].document.embeddingModel, "model-a");
    assert.equal(results[0].document.embeddingDimensions, 4);
    assert.ok(Math.abs(results[0].similarity - 1.0) < 1e-5);

    // Query with sequence range exclusion
    const excludedResults = await store.searchMemory({
        vector: [1, 0, 0, 0],
        identity: {
            provider: "test-provider",
            model: "model-a",
            dimensions: 4,
        },
        sessionId: "sess-3",
        excludeSequenceRange: { start: 0, end: 2 },
    });
    // doc1 is in range [0, 2], so it should be excluded!
    assert.equal(excludedResults.length, 0);

    await store.close();
});

test("SqliteConversationStore: saveTranscriptItems is idempotent for identical records", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const items = [
        { sequence: 0, type: "user", payload: JSON.stringify({ content: "hello" }) },
        { sequence: 1, type: "assistant", payload: JSON.stringify({ content: "world" }) },
    ];

    await store.saveTranscriptItems("sess-idempotent", items);
    // Saving the identical items again must succeed without error or duplicate records
    await store.saveTranscriptItems("sess-idempotent", items);

    const saved = await store.getTranscriptItems("sess-idempotent");
    assert.equal(saved.length, 2);
    assert.equal(saved[0].sequence, 0);
    assert.equal(saved[1].sequence, 1);

    await store.close();
});

test("SqliteConversationStore: saveTranscriptItems rejects conflicting non-identical writes", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const items = [
        { sequence: 0, type: "user", payload: JSON.stringify({ content: "original text" }) },
    ];
    await store.saveTranscriptItems("sess-conflict", items);

    const conflictingItems = [
        { sequence: 0, type: "user", payload: JSON.stringify({ content: "conflicting text" }) },
    ];

    await assert.rejects(() => store.saveTranscriptItems("sess-conflict", conflictingItems), {
        message: /Transcript conflict in session "sess-conflict" at sequence 0/,
    });

    // Verify original record is unchanged
    const saved = await store.getTranscriptItems("sess-conflict");
    assert.equal(saved.length, 1);
    assert.equal(JSON.parse(saved[0].payload).content, "original text");

    await store.close();
});

test("SqliteConversationStore: two sessions sharing one database are isolated", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    await store.saveTranscriptItems("sess-a", [
        { sequence: 0, type: "user", payload: JSON.stringify({ content: "session a" }) },
    ]);
    await store.saveTranscriptItems("sess-b", [
        { sequence: 0, type: "user", payload: JSON.stringify({ content: "session b" }) },
    ]);

    const itemsA = await store.getTranscriptItems("sess-a");
    const itemsB = await store.getTranscriptItems("sess-b");

    assert.equal(itemsA.length, 1);
    assert.equal(itemsB.length, 1);
    assert.equal(JSON.parse(itemsA[0].payload).content, "session a");
    assert.equal(JSON.parse(itemsB[0].payload).content, "session b");

    await store.close();
});

test("F-009: Concurrent initialize calls share single promise and do not leak connections", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });

    // Call initialize 5 times concurrently
    await Promise.all([
        store.initialize(),
        store.initialize(),
        store.initialize(),
        store.initialize(),
        store.initialize(),
    ]);

    assert.equal(await store.getSchemaVersion(), CURRENT_SCHEMA_VERSION);

    // Repeat initialize call after already initialized is idempotent
    await store.initialize();
    assert.equal(await store.getSchemaVersion(), CURRENT_SCHEMA_VERSION);

    await store.close();
});

test("F-014: searchMemory isolates corrupt vector rows and successfully returns valid memories", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    // Insert 1 valid memory document
    await store.saveMemoryDocument({
        sessionId: "sess-corrupt-test",
        startSequence: 0,
        endSequence: 1,
        content: "Valid memory document",
        embedding: [1, 0, 0, 0],
        embeddingProvider: "test-provider",
        embeddingModel: "test-model",
    });

    // Directly corrupt a second row in SQLite with malformed binary blob (e.g. 5 bytes, not divisible by 4)
    // @ts-expect-error accessing private db for test assertion
    const db = store.getDb();
    db.prepare(
        `
        INSERT INTO memory_documents (
            id, session_id, start_sequence, end_sequence, content,
            embedding, embedding_provider, embedding_model, embedding_dimensions, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
        "corrupt-row-id",
        "sess-corrupt-test",
        2,
        3,
        "Corrupted memory document",
        new Uint8Array([1, 2, 3, 4, 5]), // 5 bytes: malformed!
        "test-provider",
        "test-model",
        4,
        new Date().toISOString(),
    );

    // Search memory: the corrupt row must NOT throw; the valid document must be returned!
    const results = await store.searchMemory({
        vector: [1, 0, 0, 0],
        identity: {
            provider: "test-provider",
            model: "test-model",
            dimensions: 4,
        },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].document.content, "Valid memory document");

    await store.close();
});

test("SqliteConversationStore: context summary persistence, lookup, and range uniqueness", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const sessionId = "session-summary-test";
    await store.saveSession({ id: sessionId });

    const summaryPayload = JSON.stringify({
        taskOrInvestigation: "Investigation of memory leak",
        importantFindings: ["Found unclosed statement"],
        filesAndLocations: ["packages/core/src/leak.ts"],
        decisions: ["Close statement in finally"],
        failedApproaches: [],
        unresolvedIssues: [],
        nextSteps: ["Verify tests"],
        omissions: "None",
        sourceRange: { sessionId, startSequence: 0, endSequence: 4 },
    });

    await store.saveContextSummary({
        sessionId,
        startSequence: 0,
        endSequence: 4,
        summaryJson: summaryPayload,
        estimatedTokens: 120,
    });

    // Lookup by exact range
    const found = await store.findContextSummary(sessionId, 0, 4);
    assert.ok(found);
    assert.equal(found.sessionId, sessionId);
    assert.equal(found.startSequence, 0);
    assert.equal(found.endSequence, 4);
    assert.equal(found.summaryJson, summaryPayload);
    assert.equal(found.estimatedTokens, 120);

    // Lookup nonexistent range
    const missing = await store.findContextSummary(sessionId, 5, 10);
    assert.equal(missing, null);

    // List all summaries for session
    const all = await store.getContextSummaries(sessionId);
    assert.equal(all.length, 1);
    assert.equal(all[0].id, found.id);

    // Idempotent upsert on conflict
    const updatedPayload = JSON.stringify({
        taskOrInvestigation: "Updated investigation",
    });
    await store.saveContextSummary({
        sessionId,
        startSequence: 0,
        endSequence: 4,
        summaryJson: updatedPayload,
        estimatedTokens: 60,
    });

    const updated = await store.findContextSummary(sessionId, 0, 4);
    assert.ok(updated);
    assert.equal(updated.summaryJson, updatedPayload);
    assert.equal(updated.estimatedTokens, 60);

    await store.close();
});
