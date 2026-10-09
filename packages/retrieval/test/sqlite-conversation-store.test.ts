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
    assert.equal(version, 1);

    await store.close();
});

test("SqliteConversationStore: schema initialization is idempotent", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "akkco-sqlite-test-"));
    const dbPath = join(tmpDir, "test.db");

    try {
        const store1 = new SqliteConversationStore({ dbPath });
        await store1.initialize();
        assert.equal(await store1.getSchemaVersion(), 1);
        await store1.close();

        // Reopen same database file
        const store2 = new SqliteConversationStore({ dbPath });
        await store2.initialize();
        // Call initialize twice on the same instance
        await store2.initialize();
        assert.equal(await store2.getSchemaVersion(), 1);
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
