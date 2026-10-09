import assert from "node:assert/strict";
import test from "node:test";
import { SqliteConversationStore } from "@akkco/retrieval";
import {
    ConversationMemoryOrchestrator,
    createAkkcoRuntime,
    Session,
    type TranscriptItem,
} from "../src/index.js";

test("sessionPersistence: records completed turns in SQLite store", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const orchestrator = new ConversationMemoryOrchestrator(store);

    const runtime = createAkkcoRuntime({
        id: "mock",
        async *stream() {
            yield { type: "text", content: "response 1" };
        },
    });

    const session = new Session(runtime, [], {
        id: "persisted-session",
        persistence: orchestrator,
    });

    for await (const _ of session.send("hello 1")) {
    }
    for await (const _ of session.send("hello 2")) {
    }

    // Verify transcript in SQLite
    const savedItems = await store.getTranscriptItems("persisted-session");
    assert.equal(savedItems.length, 4); // 2 user, 2 assistant

    assert.equal(savedItems[0].sequence, 0);
    assert.equal(savedItems[1].sequence, 1);
    assert.equal(savedItems[2].sequence, 2);
    assert.equal(savedItems[3].sequence, 3);

    const parsed0 = JSON.parse(savedItems[0].payload);
    assert.equal(parsed0.type, "user");
    assert.equal(parsed0.content, "hello 1");

    await store.close();
});

test("sessionPersistence: preserves in-memory transcript even if persistence throws", async () => {
    const failingPersistence = {
        saveTranscriptItems: async () => {
            throw new Error("Disk full or database locked");
        },
    };

    const runtime = createAkkcoRuntime({
        id: "mock",
        async *stream() {
            yield { type: "text", content: "response text" };
        },
    });

    const session = new Session(runtime, [], {
        id: "failing-persist-session",
        persistence: failingPersistence,
    });

    await assert.rejects(
        async () => {
            for await (const _ of session.send("test input")) {
            }
        },
        { message: /Disk full or database locked/ },
    );

    // Documented semantics: In-memory transcript is preserved and intact!
    assert.equal(session.transcript.length, 2);
    assert.equal(session.transcript[0].type, "user");
    assert.equal(session.transcript[0].content, "test input");
    assert.equal(session.transcript[1].type, "assistant");
    assert.equal((session.transcript[1] as any).content, "response text");
});
