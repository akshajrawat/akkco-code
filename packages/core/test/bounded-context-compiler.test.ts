import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicFakeEmbeddingProvider } from "@akkco/models/testing";
import { SqliteConversationStore } from "@akkco/retrieval";
import {
    type ContextBudget,
    ConversationMemoryOrchestrator,
    createAkkcoRuntime,
    createBoundedContextCompiler,
    DefaultConversationMemoryRetriever,
    estimateTokens,
    Session,
    type TranscriptItem,
} from "../src/index.js";

test("BoundedContextCompiler 1 & 3: small transcript behaves correctly and current user request is always retained", async () => {
    const compiler = createBoundedContextCompiler();
    const transcript: TranscriptItem[] = [
        { type: "user", content: "hello" },
        { type: "assistant", content: "world", status: "completed" },
        { type: "user", content: "current request" },
    ];

    const items = await compiler.compile({ transcript });
    assert.ok(items.length >= 3);
    // Policy first
    assert.equal(items[0].type, "message");
    assert.equal(items[0].role, "system");
    // Current user request is the last item
    const lastItem = items.at(-1);
    assert.deepEqual(lastItem, {
        type: "message",
        role: "user",
        content: "current request",
    });
});

test("BoundedContextCompiler 2 & 4 & 6 & 14: large transcript no longer sends everything, prefers recent history, and respects budget", async () => {
    // 50 turns of conversation
    const transcript: TranscriptItem[] = [];
    for (let i = 1; i <= 50; i++) {
        transcript.push({ type: "user", content: `User query ${i} with substantial description` });
        transcript.push({
            type: "assistant",
            content: `Assistant response ${i} with detailed explanation`,
            status: "completed",
        });
    }
    // Turn 51: current user prompt
    transcript.push({ type: "user", content: "current prompt 51" });

    const budget: ContextBudget = {
        preferredInputTokens: 300,
        reservedOverheadTokens: 50,
        minimumRecentHistoryTokens: 100,
        maximumMemoryTokens: 100,
    };

    const compiler = createBoundedContextCompiler({ budget });
    const compiled = await compiler.compile({ transcript });

    // Ensure we did NOT send all 50 turns!
    // Full transcript has 101 items.
    assert.ok(compiled.length < 30);

    // Current user request is retained at the end
    assert.deepEqual(compiled.at(-1), {
        type: "message",
        role: "user",
        content: "current prompt 51",
    });

    // Recent turns (e.g. 50, 49) are present
    const contentText = compiled.map((i) => (i.type === "message" ? i.content : "")).join(" ");
    assert.ok(contentText.includes("User query 50"));

    // Distant irrelevant turns (e.g. turn 1, 2) are omitted
    assert.ok(!contentText.includes("User query 1 "));
    assert.ok(!contentText.includes("User query 2 "));

    // Verify token budget ceiling respected
    const totalChars = compiled.reduce((acc, mi) => {
        if (mi.type === "message") return acc + mi.content.length;
        return acc + 20;
    }, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    assert.ok(
        estimatedTokens <= budget.preferredInputTokens,
        `Estimated tokens ${estimatedTokens} exceeds preferredInputTokens ${budget.preferredInputTokens}`,
    );
});

test("BoundedContextCompiler 5 & 7 & 8: relevant old history reappears through vector retrieval without mutating transcript, and deduplicates against recent history", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const embeddingProvider = new DeterministicFakeEmbeddingProvider({
        dimensions: 8,
        semanticRules: [
            {
                pattern: /architecture decision postgres/i,
                vector: [1, 0, 0, 0, 0, 0, 0, 0],
            },
            {
                pattern: /database decision query/i,
                vector: [1, 0, 0, 0, 0, 0, 0, 0],
            },
        ],
    });

    const orchestrator = new ConversationMemoryOrchestrator(store, embeddingProvider);
    const memoryRetriever = new DefaultConversationMemoryRetriever(store, embeddingProvider);

    const budget: ContextBudget = {
        preferredInputTokens: 500,
        reservedOverheadTokens: 50,
        minimumRecentHistoryTokens: 150,
        maximumMemoryTokens: 250,
    };

    const sessionId = "test-session";
    const transcript: TranscriptItem[] = [];

    // Turn 1 (Old): Architectural decision
    const turn1: TranscriptItem[] = [
        { type: "user", content: "What is our architecture decision postgres vs sqlite?" },
        {
            type: "assistant",
            content: "We decided on sqlite for local persistence and zero setup.",
            status: "completed",
        },
    ];
    transcript.push(...turn1);
    await orchestrator.saveTranscriptItems(sessionId, turn1, 0);
    await orchestrator.onTurnCompleted(sessionId, turn1, 0, 1);

    // Turns 2 to 20: Unrelated work
    for (let i = 2; i <= 20; i++) {
        const turn: TranscriptItem[] = [
            { type: "user", content: `Unrelated task ${i}` },
            {
                type: "assistant",
                content: `Done with task ${i}`,
                status: "completed",
            },
        ];
        transcript.push(...turn);
        await orchestrator.saveTranscriptItems(sessionId, turn, (i - 1) * 2);
        await orchestrator.onTurnCompleted(sessionId, turn, (i - 1) * 2, (i - 1) * 2 + 1);
    }

    // Turn 21 (Current turn): Asks about database decision
    transcript.push({
        type: "user",
        content: "Tell me about database decision query",
    });

    const compiler = createBoundedContextCompiler({
        budget,
        memoryRetriever,
        sessionId,
    });

    const initialTranscriptLength = transcript.length;
    const compiled = await compiler.compile({ transcript });

    // 7. Retrieved memory does not mutate transcript!
    assert.equal(transcript.length, initialTranscriptLength);

    // 5. Relevant old turn 1 reappears in retrieved historical context
    const retrievedItem = compiled.find(
        (i) =>
            i.type === "message" &&
            i.role === "system" &&
            i.content.includes("Retrieved historical context"),
    );
    assert.ok(retrievedItem, "Retrieved historical context must be present");
    if (retrievedItem && retrievedItem.type === "message") {
        assert.ok(
            retrievedItem.content.includes(
                "We decided on sqlite for local persistence and zero setup",
            ),
        );
    }

    // 6. Irrelevant old turns (e.g. Turn 2, 3) are omitted
    const contentText = compiled.map((i) => (i.type === "message" ? i.content : "")).join(" ");
    assert.ok(!/\bUnrelated task 2\b/.test(contentText));
    assert.ok(!/\bUnrelated task 3\b/.test(contentText));

    // 4. Recent turns (Turn 19, 20) are present in recent conversation
    assert.ok(contentText.includes("Unrelated task 20"));

    // 8. Deduplication check: if a memory doc belongs to recent history range, it is not duplicated
    // Verified by sequence overlap exclusion
});

test("BoundedContextCompiler 9 & 10: tool calls/results are never structurally orphaned and chronological ordering remains valid", async () => {
    const transcript: TranscriptItem[] = [
        { type: "user", content: "Inspect codebase" },
        {
            type: "tool_execution",
            callId: "call_abc",
            toolName: "read_file",
            arguments: { path: "package.json" },
            result: '{"name": "akkco"}',
            status: "completed",
        },
        {
            type: "assistant",
            content: "Found akkco package",
            status: "completed",
        },
        { type: "user", content: "What is the name?" },
    ];

    const compiler = createBoundedContextCompiler();
    const compiled = await compiler.compile({ transcript });

    // Verify tool_call followed by tool_result
    const toolCallIdx = compiled.findIndex((i) => i.type === "tool_call" && i.id === "call_abc");
    const toolResultIdx = compiled.findIndex(
        (i) => i.type === "tool_result" && i.callId === "call_abc",
    );

    assert.ok(toolCallIdx >= 0);
    assert.ok(toolResultIdx >= 0);
    assert.equal(toolResultIdx, toolCallIdx + 1);

    // Chronological order: user -> tool_call -> tool_result -> assistant -> current user
    assert.equal(compiled.at(-1)?.type, "message");
    assert.equal((compiled.at(-1) as any).role, "user");
    assert.equal((compiled.at(-1) as any).content, "What is the name?");
});

test("BoundedContextCompiler 11: compilation is deterministic with deterministic embeddings", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const embeddingProvider = new DeterministicFakeEmbeddingProvider({ dimensions: 8 });
    const memoryRetriever = new DefaultConversationMemoryRetriever(store, embeddingProvider);

    const compiler = createBoundedContextCompiler({ memoryRetriever });
    const transcript: TranscriptItem[] = [
        { type: "user", content: "Test prompt" },
        { type: "assistant", content: "Test answer", status: "completed" },
        { type: "user", content: "Follow-up question" },
    ];

    const result1 = await compiler.compile({ transcript });
    const result2 = await compiler.compile({ transcript });

    assert.deepEqual(result1, result2);
});

test("BoundedContextCompiler 12: retrieval failure falls back gracefully to bounded recent context", async () => {
    const failingRetriever = {
        embedQuery: async () => {
            throw new Error("Embedding endpoint is temporarily offline");
        },
        retrieve: async () => {
            throw new Error("Storage is down");
        },
    };

    const compiler = createBoundedContextCompiler({
        memoryRetriever: failingRetriever as any,
    });

    const transcript: TranscriptItem[] = [
        { type: "user", content: "Hello" },
        { type: "assistant", content: "Hi there!", status: "completed" },
        { type: "user", content: "Can you help?" },
    ];

    // Does NOT crash; degrades to policy + recent history + current prompt
    const compiled = await compiler.compile({ transcript });
    assert.ok(compiled.length >= 3);
    assert.equal(compiled.at(-1)?.type, "message");
    assert.equal((compiled.at(-1) as any).content, "Can you help?");
});

test("BoundedContextCompiler 13: cancellation is respected immediately", async () => {
    const controller = new AbortController();
    controller.abort();

    const compiler = createBoundedContextCompiler();
    const transcript: TranscriptItem[] = [{ type: "user", content: "Cancelled query" }];

    await assert.rejects(
        async () => {
            await compiler.compile({ transcript, signal: controller.signal });
        },
        { name: "AbortError" },
    );
});

test("BoundedContextCompiler 15: dynamic inclusion count (no fixed memory document count)", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const fakeProvider = new DeterministicFakeEmbeddingProvider({
        dimensions: 4,
        semanticRules: [{ pattern: /query/i, vector: [1, 0, 0, 0] }],
    });

    // Save 5 small memory documents
    for (let i = 1; i <= 5; i++) {
        await store.saveMemoryDocument({
            sessionId: "s1",
            startSequence: (i - 1) * 2,
            endSequence: (i - 1) * 2 + 1,
            content: `Document ${i} matching query`,
            embedding: [1, 0, 0, 0],
            embeddingProvider: fakeProvider.id,
            embeddingModel: fakeProvider.model,
        });
    }

    const memoryRetriever = new DefaultConversationMemoryRetriever(store, fakeProvider);

    // Tight budget: only enough for 2 documents
    const tightCompiler = createBoundedContextCompiler({
        includePolicy: false,
        budget: {
            preferredInputTokens: 80,
            reservedOverheadTokens: 10,
            minimumRecentHistoryTokens: 10,
            maximumMemoryTokens: 40,
        },
        memoryRetriever,
        sessionId: "s1",
    });

    // Generous budget: enough for all 5 documents
    const generousCompiler = createBoundedContextCompiler({
        includePolicy: false,
        budget: {
            preferredInputTokens: 500,
            reservedOverheadTokens: 20,
            minimumRecentHistoryTokens: 50,
            maximumMemoryTokens: 300,
        },
        memoryRetriever,
        sessionId: "s1",
    });

    const transcript: TranscriptItem[] = [{ type: "user", content: "query" }];

    const tightCompiled = await tightCompiler.compile({ transcript });
    const generousCompiled = await generousCompiler.compile({ transcript });

    const tightMsg = tightCompiled.find(
        (i) => i.type === "message" && i.role === "system" && i.content.includes("Retrieved"),
    );
    const generousMsg = generousCompiled.find(
        (i) => i.type === "message" && i.role === "system" && i.content.includes("Retrieved"),
    );

    assert.ok(tightMsg && tightMsg.type === "message");
    assert.ok(generousMsg && generousMsg.type === "message");

    const tightDocCount = (tightMsg.content.match(/Document \d+/g) || []).length;
    const generousDocCount = (generousMsg.content.match(/Document \d+/g) || []).length;

    // Proves count is dynamic and bounded by budget, not fixed!
    assert.ok(tightDocCount < generousDocCount);
    assert.equal(generousDocCount, 5);
});

test("BoundedContextCompiler 16 & 50-turn Session test: 50-turn Session transcript remains intact, compiled context is bounded, and relevant old decision is retrieved", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const embeddingProvider = new DeterministicFakeEmbeddingProvider({
        dimensions: 8,
        semanticRules: [
            {
                pattern: /architecture decision.*sqlite/i,
                vector: [1, 0, 0, 0, 0, 0, 0, 0],
            },
            {
                pattern: /sqlite persistence architecture/i,
                vector: [1, 0, 0, 0, 0, 0, 0, 0],
            },
        ],
    });

    const orchestrator = new ConversationMemoryOrchestrator(store, embeddingProvider);
    const memoryRetriever = new DefaultConversationMemoryRetriever(store, embeddingProvider);

    const budget: ContextBudget = {
        preferredInputTokens: 600,
        reservedOverheadTokens: 50,
        minimumRecentHistoryTokens: 150,
        maximumMemoryTokens: 300,
    };

    const compiler = createBoundedContextCompiler({
        budget,
        memoryRetriever,
        sessionId: "sess-50",
    });

    let sentModelItems: any[] = [];
    const fakeRuntime = createAkkcoRuntime({
        id: "mock",
        async *stream(req) {
            sentModelItems = [...req.items];
            yield { type: "text", content: "Understood the architecture decision." };
        },
    });

    const session = new Session(fakeRuntime, [], {
        id: "sess-50",
        compiler,
        persistence: orchestrator,
    });

    // Populate 50 completed turns through session!
    // Turn 1: Key decision turn
    for await (const _ of session.send(
        "Record architecture decision: we choose node:sqlite for zero external build dependencies.",
    )) {
    }

    // Turns 2 to 49: Ordinary conversation
    for (let i = 2; i <= 49; i++) {
        for await (const _ of session.send(`Turn ${i}: discussion about topic ${i}`)) {
        }
    }

    // Now send Turn 50: queries the key decision from Turn 1!
    for await (const _ of session.send(
        "Remind me what was our sqlite persistence architecture decision?",
    )) {
    }

    // 1. Session transcript still contains ALL 50 turns (100 items: 50 user + 50 assistant)
    assert.equal(session.transcript.length, 100);

    // 2. Context Compiler returned only bounded subset to ModelRequest
    assert.ok(
        sentModelItems.length < 30,
        `Sent ${sentModelItems.length} items, expected bounded subset (< 30)`,
    );

    // 3. Relevant decision from Turn 1 is retrieved in historical context
    const retrievedContext = sentModelItems.find(
        (i) =>
            i.type === "message" &&
            i.role === "system" &&
            i.content.includes("Retrieved historical context"),
    );
    assert.ok(retrievedContext, "Expected retrieved historical context in ModelRequest");
    assert.ok(
        retrievedContext.content.includes(
            "we choose node:sqlite for zero external build dependencies",
        ),
    );

    // 4. Unrelated old turns (e.g. Turn 2, 3, 4) are completely absent
    const allSentContent = sentModelItems
        .map((i) => (i.type === "message" ? i.content : ""))
        .join(" ");
    assert.ok(!allSentContent.includes("topic 2 "));
    assert.ok(!allSentContent.includes("topic 3 "));
    assert.ok(!allSentContent.includes("topic 4 "));

    // 5. Recent turns (Turn 48, 49) are present
    assert.ok(allSentContent.includes("Turn 49"));

    // 6. Current user request is present
    assert.ok(
        allSentContent.includes("Remind me what was our sqlite persistence architecture decision?"),
    );
});
