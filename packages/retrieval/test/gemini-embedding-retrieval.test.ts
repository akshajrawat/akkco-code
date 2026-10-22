import assert from "node:assert/strict";
import test from "node:test";
import { ConversationMemoryOrchestrator, DefaultConversationMemoryRetriever } from "@akkco/core";
import { GeminiEmbeddingProvider, OpenAICompatibleEmbeddingProvider } from "@akkco/providers";
import { SqliteConversationStore } from "../src/index.js";

const create768Vector = (seed: number): number[] => {
    const vec = new Array(768);
    let norm = 0;
    for (let i = 0; i < 768; i++) {
        const val = Math.sin(seed + i * 0.05);
        vec[i] = val;
        norm += val * val;
    }
    const mag = Math.sqrt(norm);
    return vec.map((v) => v / mag);
};

test("Gemini embedding retrieval: successful indexing and retrieval with 768-dimensional output", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const mockVec = create768Vector(1.0);
    const mockQueryVec = create768Vector(1.0);

    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-gemini-key",
        dimensions: 768,
        fetch: async (_url, init) => {
            const body = JSON.parse(init?.body as string);
            assert.equal(body.requests[0].outputDimensionality, 768);
            return new Response(
                JSON.stringify({
                    embeddings: [{ values: mockVec }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    const orchestrator = new ConversationMemoryOrchestrator(store, provider);
    const retriever = new DefaultConversationMemoryRetriever(store, provider);

    const sessionId = "gemini-sess-1";
    await store.saveSession({ id: sessionId });

    // Turn: user asks for auth implementation, assistant completes it
    await orchestrator.onTurnCompleted(
        sessionId,
        [
            {
                type: "user",
                content: "How do I implement JWT auth?",
            },
            {
                type: "assistant",
                content: "Use sign and verify with HS256",
                status: "completed",
            },
        ],
        0,
        1,
    );
    await orchestrator.waitForPendingIndexing();

    // Verify record in SQLite has gemini identity and 768 dimensions
    const docs = await store.getMemoryDocuments(sessionId);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].embeddingProvider, "gemini");
    assert.equal(docs[0].embeddingModel, "gemini-embedding-001");
    assert.equal(docs[0].embeddingDimensions, 768);

    // Retrieve via retriever
    const candidates = await retriever.retrieve({
        queryText: "JWT authentication",
        sessionId,
    });

    assert.equal(candidates.length, 1);
    assert.equal(
        candidates[0].document.content,
        "User: How do I implement JWT auth?\nAssistant: Use sign and verify with HS256",
    );
    assert.equal(candidates[0].document.embeddingProvider, "gemini");
    assert.equal(candidates[0].document.embeddingModel, "gemini-embedding-001");
    assert.equal(candidates[0].document.embeddingDimensions, 768);
    assert.ok(Math.abs(candidates[0].similarity - 1.0) < 1e-4);

    await store.close();
});

test("Gemini embedding retrieval: model identity isolation between Nomic and Gemini (768 dimensions)", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const nomicVector = create768Vector(2.0);
    const geminiVector = create768Vector(5.0);

    const sessionId = "isolation-sess";
    await store.saveSession({ id: sessionId });

    // 1. Save document with Nomic embedding
    await store.saveMemoryDocument({
        sessionId,
        startSequence: 0,
        endSequence: 1,
        content: "Nomic turn content about databases",
        embedding: nomicVector,
        embeddingProvider: "openai-compatible",
        embeddingModel: "nomic-embed-text",
    });

    // 2. Save document with Gemini embedding for the same sequence range
    await store.saveMemoryDocument({
        sessionId,
        startSequence: 0,
        endSequence: 1,
        content: "Gemini turn content about databases",
        embedding: geminiVector,
        embeddingProvider: "gemini",
        embeddingModel: "gemini-embedding-001",
    });

    // Both documents must coexist in SQLite without overwriting
    const allDocs = await store.getMemoryDocuments(sessionId);
    assert.equal(
        allDocs.length,
        2,
        "Both Nomic and Gemini vectors must coexist without overwriting",
    );

    const nomicDoc = allDocs.find((d) => d.embeddingProvider === "openai-compatible");
    const geminiDoc = allDocs.find((d) => d.embeddingProvider === "gemini");
    assert.ok(nomicDoc, "Nomic document must exist");
    assert.ok(geminiDoc, "Gemini document must exist");
    assert.notEqual(nomicDoc.id, geminiDoc.id, "Documents must have distinct IDs");

    // 3. Search using Gemini provider
    const geminiProvider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        dimensions: 768,
        fetch: async () =>
            new Response(
                JSON.stringify({
                    embeddings: [{ values: geminiVector }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            ),
    });
    const geminiRetriever = new DefaultConversationMemoryRetriever(store, geminiProvider);

    const geminiResults = await geminiRetriever.retrieve({
        queryText: "databases",
        sessionId,
    });

    // Must ONLY return Gemini document, NEVER Nomic document
    assert.equal(geminiResults.length, 1);
    assert.equal(geminiResults[0].document.embeddingProvider, "gemini");
    assert.equal(geminiResults[0].document.embeddingModel, "gemini-embedding-001");
    assert.equal(geminiResults[0].document.content, "Gemini turn content about databases");

    // 4. Search using Nomic provider
    const nomicProvider = new OpenAICompatibleEmbeddingProvider({
        baseUrl: "http://localhost:11434/v1",
        model: "nomic-embed-text",
        dimensions: 768,
    });
    // Mock fetch for nomicProvider
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                data: [{ index: 0, embedding: nomicVector }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
        );

    try {
        const nomicRetriever = new DefaultConversationMemoryRetriever(store, nomicProvider);
        const nomicResults = await nomicRetriever.retrieve({
            queryText: "databases",
            sessionId,
        });

        // Must ONLY return Nomic document, NEVER Gemini document
        assert.equal(nomicResults.length, 1);
        assert.equal(nomicResults[0].document.embeddingProvider, "openai-compatible");
        assert.equal(nomicResults[0].document.embeddingModel, "nomic-embed-text");
        assert.equal(nomicResults[0].document.content, "Nomic turn content about databases");
    } finally {
        globalThis.fetch = origFetch;
    }

    await store.close();
});

test("Gemini embedding retrieval: graceful fallback when Gemini is unavailable", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const sessionId = "fallback-sess";
    await store.saveSession({ id: sessionId });

    // Save an existing memory document
    await store.saveMemoryDocument({
        sessionId,
        startSequence: 0,
        endSequence: 1,
        content: "Existing memory",
        embedding: create768Vector(1.0),
        embeddingProvider: "gemini",
        embeddingModel: "gemini-embedding-001",
    });

    // Provider that fails (network error, rate-limit, 500)
    const failingProvider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        maxRetries: 0,
        fetch: async () => {
            return new Response("Service Unavailable", { status: 503 });
        },
    });

    const orchestrator = new ConversationMemoryOrchestrator(store, failingProvider);
    const retriever = new DefaultConversationMemoryRetriever(store, failingProvider);

    // 1. Retrieving when provider is down returns empty array without throwing
    const queryResult = await retriever.embedQuery("search query");
    assert.equal(queryResult, null, "embedQuery must return null when provider is down");

    const candidates = await retriever.retrieve({
        queryText: "search query",
        sessionId,
    });
    assert.deepEqual(candidates, [], "retrieve must return empty array when provider is down");

    // 2. Orchestrator indexing failure degrades gracefully without throwing
    await assert.doesNotReject(async () => {
        await orchestrator.onTurnCompleted(
            sessionId,
            [
                { type: "user", content: "New question" },
                {
                    type: "assistant",
                    content: "New answer",
                    status: "completed",
                },
            ],
            2,
            3,
        );
        await orchestrator.waitForPendingIndexing();
    });

    // 3. Existing historical records remain completely intact
    const docs = await store.getMemoryDocuments(sessionId);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].content, "Existing memory");

    await store.close();
});

test("Gemini embedding retrieval: credentials are never written to SQLite database", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const apiKey = "ai-secret-gemini-key-xyz-777";
    const provider = new GeminiEmbeddingProvider({
        apiKey,
        fetch: async () =>
            new Response(
                JSON.stringify({
                    embeddings: [{ values: create768Vector(1.0) }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            ),
    });

    const orchestrator = new ConversationMemoryOrchestrator(store, provider);
    const sessionId = "cred-safety-sess";
    await store.saveSession({ id: sessionId });

    await orchestrator.saveTranscriptItems(
        sessionId,
        [{ type: "user", content: "Check privacy" }],
        0,
    );

    await orchestrator.onTurnCompleted(
        sessionId,
        [
            { type: "user", content: "Check privacy" },
            {
                type: "assistant",
                content: "Verified safe",
                status: "completed",
            },
        ],
        0,
        1,
    );
    await orchestrator.waitForPendingIndexing();

    // Inspect SQLite contents directly
    // @ts-expect-error accessing private db for test assertion
    const db = store.getDb();
    const tables = ["sessions", "transcript_items", "memory_documents"];
    for (const table of tables) {
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        const json = JSON.stringify(rows);
        assert.ok(
            !json.includes(apiKey),
            `Table ${table} must never contain the API key credentials`,
        );
    }

    await store.close();
});
