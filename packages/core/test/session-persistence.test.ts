import assert from "node:assert/strict";
import test from "node:test";
import { SqliteConversationStore } from "@akkco/retrieval";
import {
    ConversationMemoryOrchestrator,
    createAkkcoRuntime,
    createBoundedModelProvider,
    Session,
    type RuntimeToolHost,
    type TranscriptItem,
} from "../src/index.js";
import type { ModelEvent, ModelProfile, ModelProvider, ModelRequest } from "@akkco/models";

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

test("Session generates collision-resistant UUID by default", () => {
    const runtime = createAkkcoRuntime({
        id: "mock",
        async *stream() {
            yield { type: "text", content: "ok" };
        },
    });

    const s1 = new Session(runtime);
    const s2 = new Session(runtime);

    assert.ok(s1.id.length >= 32);
    assert.ok(s2.id.length >= 32);
    assert.notEqual(s1.id, s2.id);
});

test("Session respects explicit session ID when provided", () => {
    const runtime = createAkkcoRuntime({
        id: "mock",
        async *stream() {
            yield { type: "text", content: "ok" };
        },
    });

    const s = new Session(runtime, [], { id: "custom-session-123" });
    assert.equal(s.id, "custom-session-123");
});

test("Session tracks sequences correctly on restoration with sequence gaps", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const orchestrator = new ConversationMemoryOrchestrator(store);

    const runtime = createAkkcoRuntime({
        id: "mock",
        async *stream() {
            yield { type: "text", content: "restored response" };
        },
    });

    // Simulate an existing session with earlier items pruned: sequences 5 and 6 exist
    await store.saveTranscriptItems("sess-gap", [
        { sequence: 5, type: "user", payload: JSON.stringify({ type: "user", content: "old q" }) },
        {
            sequence: 6,
            type: "assistant",
            payload: JSON.stringify({ type: "assistant", content: "old a", status: "completed" }),
        },
    ]);

    // Restore session with initialSequence: 7
    const restoredItems: TranscriptItem[] = [
        { type: "user", content: "old q" },
        { type: "assistant", content: "old a", status: "completed" },
    ];
    const session = new Session(runtime, restoredItems, {
        id: "sess-gap",
        persistence: orchestrator,
        initialSequence: 7,
    });

    // Run new turn
    for await (const _ of session.send("new turn")) {
    }

    const items = await store.getTranscriptItems("sess-gap");
    // Should have records 5, 6, and new turn at 7, 8
    assert.equal(items.length, 4);
    assert.equal(items[0].sequence, 5);
    assert.equal(items[1].sequence, 6);
    assert.equal(items[2].sequence, 7);
    assert.equal(items[3].sequence, 8);

    const parsed2 = JSON.parse(items[2].payload);
    assert.equal(parsed2.type, "user");
    assert.equal(parsed2.content, "new turn");

    const parsed3 = JSON.parse(items[3].payload);
    assert.equal(parsed3.type, "assistant");
    assert.equal(parsed3.content, "restored response");

    await store.close();
});

test("Session F-021: canonical transcript is protected against nested mutation", async () => {
    const initialInput = {
        type: "tool_execution" as const,
        callId: "call-1",
        toolName: "read_file",
        arguments: { path: "foo.txt", options: { deep: true } },
        status: "completed" as const,
    };

    const runtime = createAkkcoRuntime({
        id: "mock",
        async *stream() {
            yield { type: "text", content: "hello" };
        },
    });

    const session = new Session(runtime, [initialInput]);

    // Attempt mutation via the original input object passed to constructor
    (initialInput.arguments as any).options.deep = false;
    const itemFromTranscript1 = session.transcript[0];
    assert.equal((itemFromTranscript1 as any).arguments.options.deep, true);

    // Attempt mutation via the returned transcript array
    const transcriptCopy = session.transcript;
    (transcriptCopy[0] as any).arguments.path = "mutated.txt";

    // Verify canonical transcript remains unchanged
    const transcriptAfter = session.transcript;
    assert.equal((transcriptAfter[0] as any).arguments.path, "foo.txt");
});

test("Session F-005: cancelled generation records interrupted status and never indexes memory documents", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    let onTurnCompletedCalled = false;
    const persistence = {
        saveTranscriptItems: async (
            sessionId: string,
            items: readonly TranscriptItem[],
            startSeq: number,
        ) => {
            await store.saveTranscriptItems(
                sessionId,
                items.map((it, idx) => ({
                    sequence: startSeq + idx,
                    type: it.type,
                    payload: JSON.stringify(it),
                })),
            );
        },
        onTurnCompleted: async () => {
            onTurnCompletedCalled = true;
        },
    };

    const abortController = new AbortController();

    const runtime = createAkkcoRuntime({
        id: "mock",
        async *stream() {
            yield { type: "text", content: "partial chunk" };
            abortController.abort();
            yield { type: "text", content: "never seen" };
        },
    });

    const session = new Session(runtime, [], {
        id: "cancelled-session",
        persistence,
    });

    await assert.rejects(
        async () => {
            for await (const _ of session.send("start", abortController.signal)) {
            }
        },
        (err: any) => err.name === "AbortError" || /aborted/i.test(err.message),
    );

    // Verify session transcript has interrupted status
    assert.strictEqual(session.transcript.length, 2);
    assert.strictEqual(session.transcript[0].type, "user");
    assert.strictEqual(session.transcript[1].type, "assistant");
    assert.strictEqual((session.transcript[1] as any).status, "interrupted");
    assert.strictEqual((session.transcript[1] as any).content, "partial chunk");

    // Verify onTurnCompleted was NEVER called!
    assert.strictEqual(onTurnCompletedCalled, false);

    // Verify persisted records reflect interrupted status
    const persisted = await store.getTranscriptItems("cancelled-session");
    assert.strictEqual(persisted.length, 2);
    const assistantPayload = JSON.parse(persisted[1].payload);
    assert.strictEqual(assistantPayload.status, "interrupted");

    await store.close();
});

test("F-006: Memory indexing failure or timeout does not fail completed user turn", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    // Failing / hanging embedding provider
    const failingEmbedder: any = {
        id: "failing-provider",
        model: "failing-model",
        embed: async () => {
            throw new Error("Embedding endpoint 503 Service Unavailable");
        },
    };

    const orchestrator = new ConversationMemoryOrchestrator(store, failingEmbedder, 100);

    const runtime = createAkkcoRuntime({
        id: "mock",
        async *stream() {
            yield { type: "text", content: "Model response text" };
        },
    });

    const session = new Session(runtime, [], {
        id: "sess-resilient",
        persistence: orchestrator,
    });

    // The user turn MUST complete successfully despite embedding failure
    let receivedContent = "";
    for await (const chunk of session.send("Hello world")) {
        if (chunk.type === "text") {
            receivedContent += chunk.content;
        }
    }

    assert.equal(receivedContent, "Model response text");
    assert.equal(session.transcript.length, 2);
    assert.equal(session.transcript[1].type, "assistant");
    assert.equal((session.transcript[1] as any).status, "completed");

    // The transcript was durably saved in SQLite
    const saved = await store.getTranscriptItems("sess-resilient");
    assert.equal(saved.length, 2);

    await orchestrator.waitForPendingIndexing(500);
    await store.close();
});

test("F-006: waitForPendingIndexing drains active indexing operations cleanly", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    let indexingCompleted = false;
    const slowEmbedder: any = {
        id: "slow-provider",
        model: "slow-model",
        embed: async (_texts: string[]) => {
            await new Promise((r) => setTimeout(r, 50));
            indexingCompleted = true;
            return [[0.1, 0.2, 0.3, 0.4]];
        },
    };

    const orchestrator = new ConversationMemoryOrchestrator(store, slowEmbedder, 500);

    const runtime = createAkkcoRuntime({
        id: "mock",
        async *stream() {
            yield { type: "text", content: "Slow embedding response" };
        },
    });

    const session = new Session(runtime, [], {
        id: "sess-drain",
        persistence: orchestrator,
    });

    for await (const _ of session.send("Trigger indexing")) {
    }

    // Await draining
    await orchestrator.waitForPendingIndexing(1000);
    assert.equal(indexingCompleted, true);

    await store.close();
});

test("sessionPersistence: context trimming during request preparation leaves canonical in-memory transcript and SQLite transcript lossless", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const orchestrator = new ConversationMemoryOrchestrator(store);

    const capturedRequests: ModelRequest[] = [];
    const rawProvider: ModelProvider = {
        id: "mock",
        stream(req) {
            capturedRequests.push(req);
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: "text",
                        content: `Response ${capturedRequests.length}`,
                    } satisfies ModelEvent;
                },
            };
        },
    };

    const boundedProvider = createBoundedModelProvider(rawProvider);
    const runtime = createAkkcoRuntime(boundedProvider);

    // Profile with small context window: maxInputTokens = 180 - 40 - 20 = 120 tokens
    const profile: ModelProfile = {
        id: "test-small",
        contextWindowTokens: 180,
        maxOutputTokens: 40,
        safetyMarginTokens: 20,
        toolMode: "native",
        charsPerToken: 4,
    };

    const session = new Session(runtime, [], {
        id: "sess-lossless",
        persistence: orchestrator,
        profile,
    });

    // Turn 1
    const p1 = "First prompt from user ".repeat(4);
    for await (const _ of session.send(p1)) {
    }

    // Turn 2
    const p2 = "Second prompt from user ".repeat(4);
    for await (const _ of session.send(p2)) {
    }

    // Turn 3
    const p3 = "Third prompt from user ".repeat(4);
    for await (const _ of session.send(p3)) {
    }

    assert.equal(capturedRequests.length, 3);

    // In turn 3, the model request projection trimmed turn 1 to stay within budget:
    const turn3Items = capturedRequests[2].items;
    const hasTurn1InModelProjection = turn3Items.some(
        (it) => it.type === "message" && it.content === p1,
    );
    assert.equal(hasTurn1InModelProjection, false, "Turn 1 must be trimmed in model projection");

    // But the canonical in-memory session transcript retains ALL turns:
    assert.equal(session.transcript.length, 6);
    assert.equal(session.transcript[0].type, "user");
    assert.equal(session.transcript[0].content, p1);
    assert.equal(session.transcript[1].type, "assistant");
    assert.equal((session.transcript[1] as any).content, "Response 1");
    assert.equal(session.transcript[2].type, "user");
    assert.equal(session.transcript[2].content, p2);
    assert.equal(session.transcript[3].type, "assistant");
    assert.equal((session.transcript[3] as any).content, "Response 2");
    assert.equal(session.transcript[4].type, "user");
    assert.equal(session.transcript[4].content, p3);
    assert.equal(session.transcript[5].type, "assistant");
    assert.equal((session.transcript[5] as any).content, "Response 3");

    // And SQLite store transcript is 100% lossless:
    const persistedItems = await store.getTranscriptItems("sess-lossless");
    assert.equal(persistedItems.length, 6);
    for (let i = 0; i < 6; i++) {
        assert.equal(persistedItems[i].sequence, i);
    }
    const p0 = JSON.parse(persistedItems[0].payload);
    assert.equal(p0.type, "user");
    assert.equal(p0.content, p1);

    const p5 = JSON.parse(persistedItems[5].payload);
    assert.equal(p5.type, "assistant");
    assert.equal(p5.content, "Response 3");

    await store.close();
});

test("sessionPersistence: compacting tool-result for model does not mutate canonical tool execution in transcript or SQLite", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const orchestrator = new ConversationMemoryOrchestrator(store);

    const largeToolResult = "DATA_CHUNK_".repeat(60); // 660 chars ~ 165 tokens
    let step = 0;
    const capturedRequests: ModelRequest[] = [];
    const rawProvider: ModelProvider = {
        id: "mock",
        stream(req) {
            capturedRequests.push(req);
            step++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (step === 1) {
                        yield {
                            type: "tool_call",
                            id: "call_large_1",
                            name: "fetch_data",
                            arguments: { id: "data-123" },
                        } satisfies ModelEvent;
                    } else {
                        yield {
                            type: "text",
                            content: "Processed large payload.",
                        } satisfies ModelEvent;
                    }
                },
            };
        },
    };

    const boundedProvider = createBoundedModelProvider(rawProvider);
    const toolHost: RuntimeToolHost = {
        tools: [
            {
                name: "fetch_data",
                description: "fetches data",
                inputSchema: { type: "object" },
            },
        ],
        execute: async () => ({ content: largeToolResult }),
    };

    const compactor = {
        compactHistory: async () => null,
        compactToolResult: async ({ toolName, callId, targetTokens }: any) =>
            `[Summary of ${toolName} (${callId})]: Compacted payload within ${targetTokens} tokens.\n\n[Canonical transcript retains full original output]`,
    };

    const runtime = createAkkcoRuntime(
        boundedProvider,
        toolHost,
        undefined,
        undefined,
        compactor as any,
    );

    // Context budget: contextWindowTokens = 220, maxOutputTokens = 40, safetyMarginTokens = 20 -> maxInput = 160 tokens
    const profile: ModelProfile = {
        id: "test-tool-bound",
        contextWindowTokens: 220,
        maxOutputTokens: 40,
        safetyMarginTokens: 20,
        toolMode: "native",
        charsPerToken: 4,
    };

    const session = new Session(runtime, [], {
        id: "sess-tool-trunc",
        persistence: orchestrator,
        profile,
    });

    for await (const _ of session.send("fetch the data please")) {
    }

    assert.equal(capturedRequests.length, 2);

    // Check request 2 received by provider: tool_result content MUST be compacted
    const req2ToolResult = capturedRequests[1].items.find((it) => it.type === "tool_result") as any;
    assert.ok(req2ToolResult, "Must have tool_result item in model request");
    assert.ok(
        req2ToolResult.content.length < largeToolResult.length,
        "Model request projection must have compacted tool result",
    );
    assert.ok(
        req2ToolResult.content.includes("[Summary of fetch_data"),
        "Must contain summary in model projection",
    );

    // But canonical session transcript MUST retain the FULL untruncated result:
    assert.equal(session.transcript.length, 3); // user, tool_execution, assistant
    assert.equal(session.transcript[1].type, "tool_execution");
    const canonicalToolItem = session.transcript[1] as any;
    assert.equal(canonicalToolItem.result, largeToolResult);
    assert.equal(canonicalToolItem.callId, "call_large_1");
    assert.equal(canonicalToolItem.status, "completed");

    // And SQLite store MUST retain the full untruncated result:
    const persistedItems = await store.getTranscriptItems("sess-tool-trunc");
    assert.equal(persistedItems.length, 3);
    const persistedToolItem = JSON.parse(persistedItems[1].payload);
    assert.equal(persistedToolItem.type, "tool_execution");
    assert.equal(persistedToolItem.result, largeToolResult);
    assert.equal(persistedToolItem.callId, "call_large_1");
    assert.equal(persistedToolItem.status, "completed");

    await store.close();
});
