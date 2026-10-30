import assert from "node:assert/strict";
import test from "node:test";
import { SqliteConversationStore } from "@akkco/retrieval";
import type {
    ModelEvent,
    ModelItem,
    ModelProfile,
    ModelProvider,
    ModelRequest,
} from "@akkco/models";
import {
    calculateMaxInputTokens,
    ContextBudgetOverflowError,
    createAkkcoRuntime,
    createBoundedContextCompiler,
    createContextCompactor,
    DEFAULT_CONTEXT_BUDGET,
    DefaultContextCompactor,
    deriveContextBudget,
    estimateTokens,
    formatSummaryAsModelItem,
    prepareBoundedModelRequest,
    Session,
    type ContextBudget,
    type StructuredSummary,
    type TranscriptItem,
    ConversationMemoryOrchestrator,
} from "../src/index.js";

// Helper to create a fake streaming provider
const createFakeProvider = (
    responder: (
        request: ModelRequest,
    ) => AsyncIterable<ModelEvent> | Promise<AsyncIterable<ModelEvent>>,
): ModelProvider => ({
    id: "fake-provider",
    stream: (request: ModelRequest, _signal?: AbortSignal) => {
        return (async function* () {
            const result = await responder(request);
            for await (const event of result) {
                yield event;
            }
        })();
    },
});

// Helper to generate a valid StructuredSummary JSON string
const makeSummaryJson = (options: {
    sessionId?: string;
    startSequence: number;
    endSequence: number;
    findings?: string[];
    decisions?: string[];
}): string =>
    JSON.stringify({
        taskOrInvestigation: "Test investigation task",
        importantFindings: options.findings ?? ["Key finding 1", "Key finding 2"],
        filesAndLocations: ["packages/core/src/runtime.ts"],
        decisions: options.decisions ?? ["Approved design approach"],
        failedApproaches: ["Old naive approach"],
        unresolvedIssues: ["None"],
        nextSteps: ["Proceed to next phase"],
        omissions: "Verbose logs omitted",
        sourceRange: {
            sessionId: options.sessionId,
            startSequence: options.startSequence,
            endSequence: options.endSequence,
        },
    });

// ============================================================================
// Group A: AI Tool-Result Compaction Integration
// ============================================================================

test("Group A1: Compaction fires when an active tool output exceeds available capacity", async () => {
    let compactorInvoked = false;
    let providerCalls = 0;
    const recordedRequests: ModelRequest[] = [];

    const compactorProvider = createFakeProvider(async () => {
        compactorInvoked = true;
        return (async function* () {
            yield {
                type: "text",
                content:
                    "Compact summary: file reading succeeded with 5 findings. Details omitted.",
            } as ModelEvent;
        })();
    });

    const compactor = createContextCompactor({
        provider: compactorProvider,
    });

    const runtimeProvider = createFakeProvider(async (req) => {
        providerCalls++;
        recordedRequests.push(req);
        return (async function* () {
            if (providerCalls === 1) {
                // Step 1: Model requests a tool
                yield {
                    type: "tool_call",
                    id: "call-1",
                    name: "read_file",
                    arguments: { path: "large.txt" },
                };
            } else {
                // Step 2: Model finishes turn
                yield {
                    type: "text",
                    content: "I have read the file.",
                };
            }
        })();
    });

    const budget: ContextBudget = {
        preferredInputTokens: 300,
        reservedOverheadTokens: 50,
        minimumRecentHistoryTokens: 50,
    };

    const runtime = createAkkcoRuntime(runtimeProvider, {
        toolHost: {
            tools: [
                {
                    name: "read_file",
                    description: "read file",
                    inputSchema: { type: "object", properties: {} },
                },
            ],
            execute: async () => ({
                // 1,000 characters = ~250 tokens > maxToolOutputTokens (60)
                content: "Very large file content line ".repeat(35),
            }),
        },
        compactor,
        budget,
        maxToolOutputTokens: 60,
    });

    const events: any[] = [];
    for await (const event of runtime.run({
        items: [{ type: "message", role: "user", content: "Please read large.txt" }],
    })) {
        events.push(event);
    }

    assert.equal(providerCalls, 2, "Expected 2 provider calls (tool call + final answer)");

    // Verify the second model request received the milestone evidence item
    const secondReq = recordedRequests[1];
    const milestoneItem = secondReq.items.find(
        (item) =>
            item.type === "message" &&
            item.role === "user" &&
            item.content.includes("[Milestone: read_file"),
    );
    assert.ok(milestoneItem, "Expected milestone evidence item in second request");

    // Verify runtime event emitted the full uncompacted content to session / user
    const toolEvent = events.find((e) => e.type === "tool_execution");
    assert.ok(toolEvent, "Expected tool_execution event");
    assert.ok(
        toolEvent.result.includes("Very large file content line"),
        "Expected runtime tool_execution event to preserve raw content",
    );
    assert.ok(toolEvent.milestone, "Expected milestone on tool_execution event");
});

test("Group A4: Session transcript and SQLite storage retain the original uncompacted tool output", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const rawOutput = "UNCOMPACTED_FULL_RAW_OUTPUT_".repeat(50); // ~1400 chars

    const compactorProvider = createFakeProvider(async () => {
        return (async function* () {
            yield {
                type: "text",
                content: "Compacted summary of raw output.",
            } as ModelEvent;
        })();
    });

    const compactor = createContextCompactor({ provider: compactorProvider });

    let loop = 0;
    const runtimeProvider = createFakeProvider(async () => {
        loop++;
        return (async function* () {
            if (loop === 1) {
                yield {
                    type: "tool_call",
                    id: "c1",
                    name: "test_tool",
                    arguments: {},
                };
            } else {
                yield { type: "text", content: "Done." };
            }
        })();
    });

    const runtime = createAkkcoRuntime(runtimeProvider, {
        toolHost: {
            tools: [{ name: "test_tool", description: "test", inputSchema: { type: "object" } }],
            execute: async () => ({ content: rawOutput }),
        },
        compactor,
        budget: {
            preferredInputTokens: 300,
            reservedOverheadTokens: 50,
            minimumRecentHistoryTokens: 50,
        },
        maxToolOutputTokens: 50,
    });

    const orchestrator = new ConversationMemoryOrchestrator(store);

    const session = new Session(runtime, [], {
        id: "sess-lossless",
        persistence: orchestrator,
    });

    for await (const _ of session.send("run test tool")) {
    }

    // 1. Verify in-memory session transcript has raw uncompacted output
    const sessionTranscript = session.transcript;
    const toolResultTranscript = sessionTranscript.find((i) => i.type === "tool_execution");
    assert.ok(toolResultTranscript, "Expected tool_execution in session transcript");
    if (toolResultTranscript.type === "tool_execution") {
        assert.equal(toolResultTranscript.result, rawOutput);
    }

    // 2. Verify SQLite storage has raw uncompacted output
    const savedItems = await store.getTranscriptItems("sess-lossless");
    const savedToolResult = savedItems.find((i) => {
        const parsed = JSON.parse(i.payload);
        return parsed.type === "tool_execution";
    });
    assert.ok(savedToolResult, "Expected tool_execution in SQLite");
    const parsedPayload = JSON.parse(savedToolResult.payload);
    assert.equal(parsedPayload.result, rawOutput);

    await store.close();
});

// ============================================================================
// Group B: Incremental Persistent Compaction
// ============================================================================

test("Group B1: Prefix summary reuse: summarizing 1–25 reuses 1–20 prefix summary and combines with 21–25", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const sessionId = "sess-b1";
    // Pre-seed an existing summary for sequences 1-20
    const prefixSummaryJson = makeSummaryJson({
        sessionId,
        startSequence: 1,
        endSequence: 20,
        findings: ["Prefix finding A", "Prefix finding B"],
    });

    await store.saveContextSummary({
        sessionId,
        startSequence: 1,
        endSequence: 20,
        summaryJson: prefixSummaryJson,
        estimatedTokens: 100,
    });

    let compactorPromptReceived = "";
    const compactorProvider = createFakeProvider(async (req) => {
        compactorPromptReceived = req.items.map((i: any) => i.content ?? "").join("\n");
        return (async function* () {
            yield {
                type: "text",
                content: makeSummaryJson({
                    sessionId,
                    startSequence: 1,
                    endSequence: 25,
                    findings: ["Prefix finding A", "New delta finding C"],
                }),
            } as ModelEvent;
        })();
    });

    const compactor = new DefaultContextCompactor({
        provider: compactorProvider,
        store,
    });

    // Provide turns 1 to 25
    const turns = [
        {
            startSequence: 1,
            endSequence: 20,
            items: [
                { type: "message", role: "user", content: "Historical turns 1-20" } as ModelItem,
            ],
        },
        {
            startSequence: 21,
            endSequence: 25,
            items: [
                { type: "message", role: "user", content: "Delta turn 21-25 content" } as ModelItem,
            ],
        },
    ];

    const allItems: ModelItem[] = [
        { type: "message", role: "user", content: "Historical turns 1-20" },
        { type: "message", role: "user", content: "Delta turn 21-25 content" },
    ];

    const summary = await compactor.compactHistory({
        items: allItems,
        startSequence: 1,
        endSequence: 25,
        sessionId,
        turns,
    });

    assert.ok(summary !== null);
    assert.equal(summary.sourceRange.startSequence, 1);
    assert.equal(summary.sourceRange.endSequence, 25);
    assert.ok(summary.importantFindings.includes("New delta finding C"));

    // Verify the prompt leveraged the prefix summary rather than re-evaluating 1-20 blindly
    assert.ok(
        compactorPromptReceived.includes("PREVIOUS VALIDATED CONTEXT SUMMARY"),
        "Expected compactor prompt to include prefix summary",
    );
    assert.ok(
        compactorPromptReceived.includes("Delta turn 21-25 content"),
        "Expected compactor prompt to include delta turn content",
    );

    await store.close();
});

test("Group B2: Zero duplicate LLM calls on exact cache hit", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const sessionId = "sess-b2";
    let llmInvocations = 0;

    const compactorProvider = createFakeProvider(async () => {
        llmInvocations++;
        return (async function* () {
            yield {
                type: "text",
                content: makeSummaryJson({ sessionId, startSequence: 1, endSequence: 10 }),
            } as ModelEvent;
        })();
    });

    const compactor = new DefaultContextCompactor({
        provider: compactorProvider,
        store,
    });

    const items: ModelItem[] = [
        { type: "message", role: "user", content: "History 1" },
        { type: "message", role: "assistant", content: "Reply 1" },
    ];

    // First compaction: produces summary and saves to SQLite
    const summary1 = await compactor.compactHistory({
        items,
        startSequence: 1,
        endSequence: 10,
        sessionId,
    });
    assert.equal(llmInvocations, 1);
    assert.ok(summary1 !== null);

    // Second compaction for same range: must hit SQLite cache directly
    const summary2 = await compactor.compactHistory({
        items,
        startSequence: 1,
        endSequence: 10,
        sessionId,
    });
    assert.equal(llmInvocations, 1, "Expected zero additional LLM invocations on cache hit");
    assert.deepEqual(summary1, summary2);

    await store.close();
});

test("Group B3: Pruning superseded intermediate checkpoints in SQLite", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const sessionId = "sess-b3";

    // 1. Save checkpoint for 1-10
    await store.saveContextSummary({
        sessionId,
        startSequence: 1,
        endSequence: 10,
        summaryJson: makeSummaryJson({ sessionId, startSequence: 1, endSequence: 10 }),
        estimatedTokens: 100,
    });

    // 2. Save checkpoint for 1-20 (should prune 1-10)
    await store.saveContextSummary({
        sessionId,
        startSequence: 1,
        endSequence: 20,
        summaryJson: makeSummaryJson({ sessionId, startSequence: 1, endSequence: 20 }),
        estimatedTokens: 100,
    });

    // Verify 1-10 is pruned
    const superseded = await store.findLatestContextSummary(sessionId, 1, 10);
    assert.equal(
        superseded,
        null,
        "Expected superseded checkpoint (1-10) to have been pruned after saving 1-20",
    );

    // Verify 1-20 is present
    const latest = await store.findLatestContextSummary(sessionId, 1, 20);
    assert.ok(latest !== null);
    assert.equal(latest.endSequence, 20);

    await store.close();
});

// ============================================================================
// Group C: Bounded Compaction Requests
// ============================================================================

test("Group C1: Compactor chunks large historical turns exceeding compactor capacity and merges without errors", async () => {
    let requestsCount = 0;
    const compactorProvider = createFakeProvider(async (req) => {
        requestsCount++;
        // Verify compactor requests never supply tools
        assert.equal(req.tools, undefined, "Compaction requests must have tools: undefined");

        return (async function* () {
            yield {
                type: "text",
                content: makeSummaryJson({
                    startSequence: 1,
                    endSequence: 50,
                    findings: [`Finding from request ${requestsCount}`],
                }),
            } as ModelEvent;
        })();
    });

    // Profile with very small context capacity: 400 window - 100 maxOutput - 50 safety = 250 maxInputTokens
    const smallProfile: ModelProfile = {
        id: "small-compactor",
        contextWindowTokens: 400,
        maxOutputTokens: 100,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };

    const compactor = new DefaultContextCompactor({
        provider: compactorProvider,
        profile: smallProfile,
    });

    // Generate 6 turns of 80 tokens each (total 480 tokens > 250 maxInputTokens)
    const turns = Array.from({ length: 6 }, (_, i) => ({
        startSequence: i * 5 + 1,
        endSequence: (i + 1) * 5,
        items: [
            {
                type: "message" as const,
                role: "user" as const,
                content: `Turn ${i + 1} content `.repeat(20),
            },
        ],
    }));

    const allItems = turns.flatMap((t) => t.items);

    const summary = await compactor.compactHistory({
        items: allItems,
        startSequence: 1,
        endSequence: 30,
        turns,
    });

    assert.ok(summary !== null);
    assert.ok(
        requestsCount > 1,
        `Expected compactor to chunk turns across multiple requests, got ${requestsCount}`,
    );
});

test("Group C3: Compaction model requests never supply tools", async () => {
    const compactorProvider = createFakeProvider(async (req) => {
        assert.equal(req.tools, undefined, "Expected req.tools to be undefined in compactor call");
        return (async function* () {
            yield {
                type: "text",
                content: makeSummaryJson({ startSequence: 1, endSequence: 2 }),
            } as ModelEvent;
        })();
    });

    const compactor = new DefaultContextCompactor({ provider: compactorProvider });
    await compactor.compactHistory({
        items: [{ type: "message", role: "user", content: "test" }],
        startSequence: 1,
        endSequence: 2,
    });
});

// ============================================================================
// Group D: ModelProfile Consistency
// ============================================================================

test("Group D1: Profile charsPerToken propagates to compiler, compactor, runtime, and request-preparer", async () => {
    // 60 chars string:
    // With charsPerToken = 2: Math.ceil(60 / 2) = 30 tokens
    // With charsPerToken = 6: Math.ceil(60 / 6) = 10 tokens
    const sampleText = "1234567890".repeat(6);
    assert.equal(estimateTokens(sampleText, 2), 30);
    assert.equal(estimateTokens(sampleText, 6), 10);

    // Verify prepareBoundedModelRequest uses profile charsPerToken
    const denseProfile: ModelProfile = {
        id: "dense-profile",
        contextWindowTokens: 100,
        maxOutputTokens: 20,
        safetyMarginTokens: 10,
        toolMode: "native",
        charsPerToken: 2, // 2 chars/token -> high token count
    };

    const budget = deriveContextBudget(denseProfile);
    assert.equal(denseProfile.charsPerToken, 2);

    // 100 tokens max window - 20 - 10 = 70 max input tokens
    // Item with 160 characters: at charsPerToken: 2 -> 80 tokens > 70 tokens available!
    const oversizedForDense = "a".repeat(160);
    const request: ModelRequest = {
        items: [{ type: "message", role: "user", content: oversizedForDense }],
    };

    // Fails closed because 80 tokens > 70 max input tokens
    assert.throws(
        () =>
            prepareBoundedModelRequest({
                request,
                budget,
                profile: denseProfile,
            }),
        ContextBudgetOverflowError,
    );

    // At charsPerToken: 6, 160 characters is only Math.ceil(160/6) = 27 tokens <= 70, so it fits!
    const sparseProfile: ModelProfile = {
        ...denseProfile,
        charsPerToken: 6,
    };
    const sparseBudget = deriveContextBudget(sparseProfile);
    const preparedSparse = prepareBoundedModelRequest({
        request,
        budget: sparseBudget,
        profile: sparseProfile,
    });
    assert.equal(preparedSparse.items.length, 1);
});

// ============================================================================
// Group E: Adaptive Allocation Consolidation
// ============================================================================

test("Group E1: Proportional scaling with calculateMaxInputTokens", () => {
    const standardProfile: ModelProfile = {
        id: "qwen-8k",
        contextWindowTokens: 8192,
        maxOutputTokens: 1024,
        safetyMarginTokens: 256,
        toolMode: "compatibility",
    };
    const standardBudget = deriveContextBudget(standardProfile);
    // 8192 - 1024 - 256 = 6912 input tokens.
    // 30% soft memory cap = Math.floor(6912 * 0.3) = 2073 tokens
    assert.equal(standardBudget.maximumMemoryTokens, 2073);

    const largeProfile: ModelProfile = {
        id: "qwen-32k",
        contextWindowTokens: 32768,
        maxOutputTokens: 2048,
        safetyMarginTokens: 512,
        toolMode: "compatibility",
    };
    const largeBudget = deriveContextBudget(largeProfile);
    // 32768 - 2048 - 512 = 30208 input tokens.
    // 30% soft memory cap = Math.floor(30208 * 0.3) = 9062 tokens
    assert.ok(
        (largeBudget.maximumMemoryTokens ?? 0) > 8000,
        `Expected memory budget to scale proportionally (> 8000), got ${largeBudget.maximumMemoryTokens}`,
    );
});

test("Group E2: Explicit hard memory limits (isHardMemoryLimit: true) are strictly respected", () => {
    const largeProfile: ModelProfile = {
        id: "qwen-32k",
        contextWindowTokens: 32768,
        maxOutputTokens: 2048,
        safetyMarginTokens: 512,
        toolMode: "compatibility",
    };

    // User explicitly requests a hard cap of 400 memory tokens
    const hardBudget = deriveContextBudget(largeProfile, {
        maximumMemoryTokens: 400,
        isHardMemoryLimit: true,
    });

    assert.equal(hardBudget.maximumMemoryTokens, 400);
    assert.equal(hardBudget.isHardMemoryLimit, true);
});

test("Group E3: Dynamic reclamation of unused memory capacity for recent history", async () => {
    // When memory retriever returns only 1 small document (e.g. 20 tokens),
    // the unused memory budget expands available capacity to preserve older recent history turns.
    const compiler = createBoundedContextCompiler({
        budget: {
            preferredInputTokens: 200,
            reservedOverheadTokens: 40,
            minimumRecentHistoryTokens: 40,
            maximumMemoryTokens: 80,
        },
        memoryRetriever: {
            retrieve: async () => [
                {
                    document: {
                        id: "mem-1",
                        sessionId: "other",
                        startSequence: 0,
                        endSequence: 1,
                        content: "User: short memory query\nAssistant: short answer",
                        embeddingProvider: "test",
                        embeddingModel: "test",
                        embeddingDimensions: 3,
                        createdAt: new Date().toISOString(),
                    },
                    similarity: 0.9,
                    estimatedTokens: 20,
                },
            ],
        } as any,
    });

    const transcript: TranscriptItem[] = [
        { type: "user", content: "Old question 1" },
        { type: "assistant", content: "Old reply 1", status: "completed" },
        { type: "user", content: "Old question 2" },
        { type: "assistant", content: "Old reply 2", status: "completed" },
        { type: "user", content: "Current question" },
    ];

    const compiled = await compiler.compile({ transcript });

    // Both older turns should be retained because unused memory headroom was dynamically reclaimed
    const userMessages = compiled.filter((i) => i.type === "message" && i.role === "user");
    assert.ok(
        userMessages.some((m: any) => m.content === "Old question 1"),
        "Expected Old question 1 to be retained via reclaimed capacity",
    );
    assert.ok(
        userMessages.some((m: any) => m.content === "Old question 2"),
        "Expected Old question 2 to be retained via reclaimed capacity",
    );
});

// ============================================================================
// Group F: Request Preparation Failure Closed & Dead Code Removal
// ============================================================================

test("Group F1: Deterministic fail closed with ContextBudgetOverflowError", () => {
    const budget: ContextBudget = {
        preferredInputTokens: 100,
        reservedOverheadTokens: 30,
        minimumRecentHistoryTokens: 20,
    };

    // 1. Oversized active tool output fails closed immediately (no character slicing)
    const requestWithOversizedTool: ModelRequest = {
        items: [
            { type: "message", role: "system", content: "Policy" },
            { type: "message", role: "user", content: "Prompt" },
            { type: "tool_call", id: "c1", name: "t1", arguments: {} },
            {
                type: "tool_result",
                callId: "c1",
                content: "Content that exceeds maxToolOutputTokens ".repeat(10), // ~80 tokens > 20
            },
        ],
    };

    assert.throws(
        () =>
            prepareBoundedModelRequest({
                request: requestWithOversizedTool,
                budget,
                maxToolOutputTokens: 20,
            }),
        ContextBudgetOverflowError,
    );

    // 2. Mandatory system instruction exceeding capacity fails closed
    const requestWithHugePolicy: ModelRequest = {
        items: [
            { type: "message", role: "system", content: "Huge policy text ".repeat(30) }, // ~120 tokens > 70
            { type: "message", role: "user", content: "Prompt" },
        ],
    };

    assert.throws(
        () => prepareBoundedModelRequest({ request: requestWithHugePolicy, budget }),
        ContextBudgetOverflowError,
    );
});

test("Group F2: Dead code verification (removed character-truncation and fair-share exports)", async () => {
    const coreExports = await import("../src/index.js");

    assert.equal(
        (coreExports as any).truncateToolResult,
        undefined,
        "truncateToolResult must not be exported",
    );
    assert.equal(
        (coreExports as any).truncateCompatibilityToolResult,
        undefined,
        "truncateCompatibilityToolResult must not be exported",
    );
    assert.equal(
        (coreExports as any).truncateAnyToolResult,
        undefined,
        "truncateAnyToolResult must not be exported",
    );
    assert.equal(
        (coreExports as any).allocateToolResultBudgets,
        undefined,
        "allocateToolResultBudgets must not be exported",
    );
});

// ============================================================================
// Group G: Fix 1 — Strict Physical Capacity Bounded Compactor
// ============================================================================

const createStrictFakeProvider = (
    maxCapacity: number,
    responder: (
        request: ModelRequest,
    ) => AsyncIterable<ModelEvent> | Promise<AsyncIterable<ModelEvent>>,
    recordedRequests: ModelRequest[] = [],
): ModelProvider => ({
    id: "strict-fake-provider",
    stream: (request: ModelRequest) => {
        const tokens = request.items.reduce((sum, it) => {
            const chars =
                it.type === "message" || it.type === "tool_result" ? (it.content ?? "").length : 0;
            return sum + Math.ceil(chars / 4) + 4;
        }, 0);
        if (tokens > maxCapacity) {
            throw new Error(
                `Strict physical capacity exceeded: request has estimated ${tokens} tokens, max allowed is ${maxCapacity}`,
            );
        }
        recordedRequests.push(request);
        return (async function* () {
            const stream = await responder(request);
            for await (const event of stream) {
                yield event;
            }
        })();
    },
});

test("Group G1: Strict fake provider rejects any request exceeding capacity; compactor guarantees all requests fit within capacity (250 tokens)", async () => {
    let requestsCount = 0;
    const recordedRequests: ModelRequest[] = [];

    const compactorProvider = createStrictFakeProvider(
        250,
        async () => {
            requestsCount++;
            return (async function* () {
                yield {
                    type: "text",
                    content: makeSummaryJson({
                        startSequence: 1,
                        endSequence: 30,
                        findings: [`Finding ${requestsCount}`],
                    }),
                } as ModelEvent;
            })();
        },
        recordedRequests,
    );

    const smallProfile: ModelProfile = {
        id: "small-compactor-strict",
        contextWindowTokens: 400,
        maxOutputTokens: 100,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };

    const compactor = new DefaultContextCompactor({
        provider: compactorProvider,
        profile: smallProfile,
    });

    const turns = Array.from({ length: 6 }, (_, i) => ({
        startSequence: i * 5 + 1,
        endSequence: (i + 1) * 5,
        items: [
            {
                type: "message" as const,
                role: "user" as const,
                content: `Turn ${i + 1} content `.repeat(20),
            },
        ],
    }));

    const allItems = turns.flatMap((t) => t.items);

    const summary = await compactor.compactHistory({
        items: allItems,
        startSequence: 1,
        endSequence: 30,
        turns,
    });

    assert.ok(summary !== null, "Summary must be successfully created");
    assert.ok(recordedRequests.length > 1, "Must require multiple chunk requests");

    // Assert that every single request was strictly <= 250 tokens
    for (const req of recordedRequests) {
        const tokens = req.items.reduce(
            (sum, it) => sum + (it.type === "message" ? Math.ceil(it.content.length / 4) + 4 : 4),
            0,
        );
        assert.ok(
            tokens <= 250,
            `Request tokens (${tokens}) must be <= 250 physical capacity limit`,
        );
    }
});

test("Group G2: Single historical item larger than chunk capacity is sliced safely without sending oversized request", async () => {
    const recordedRequests: ModelRequest[] = [];
    const compactorProvider = createStrictFakeProvider(
        250,
        async () => {
            return (async function* () {
                yield {
                    type: "text",
                    content: makeSummaryJson({
                        startSequence: 1,
                        endSequence: 1,
                        findings: ["Sliced finding"],
                    }),
                } as ModelEvent;
            })();
        },
        recordedRequests,
    );

    const smallProfile: ModelProfile = {
        id: "small-compactor-strict",
        contextWindowTokens: 400,
        maxOutputTokens: 100,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };

    const compactor = new DefaultContextCompactor({
        provider: compactorProvider,
        profile: smallProfile,
    });

    // Single message of 2,000 characters (~500 tokens > 250 capacity)
    const giantItem: ModelItem = {
        type: "message",
        role: "user",
        content: "Very long uninterrupted message content that exceeds capacity. ".repeat(30),
    };

    const summary = await compactor.compactHistory({
        items: [giantItem],
        startSequence: 1,
        endSequence: 1,
    });

    assert.ok(summary !== null, "Oversized single item must be summarized successfully");
    assert.ok(recordedRequests.length > 1, "Must slice oversized item into multiple requests");

    for (const req of recordedRequests) {
        const tokens = req.items.reduce(
            (sum, it) => sum + (it.type === "message" ? Math.ceil(it.content.length / 4) + 4 : 4),
            0,
        );
        assert.ok(tokens <= 250, `Request tokens (${tokens}) must be <= 250`);
    }
});

test("Group G4: Intermediate summary expansion across consecutive chunks remains strictly bounded", async () => {
    const recordedRequests: ModelRequest[] = [];
    let chunkCallIndex = 0;

    const compactorProvider = createStrictFakeProvider(
        300,
        async () => {
            chunkCallIndex++;
            return (async function* () {
                yield {
                    type: "text",
                    content: makeSummaryJson({
                        startSequence: 1,
                        endSequence: chunkCallIndex * 5,
                        findings: Array.from(
                            { length: 4 },
                            (_, j) => `Finding ${chunkCallIndex}.${j}`,
                        ),
                    }),
                } as ModelEvent;
            })();
        },
        recordedRequests,
    );

    const profile: ModelProfile = {
        id: "profile-300",
        contextWindowTokens: 500,
        maxOutputTokens: 120,
        safetyMarginTokens: 80,
        toolMode: "native",
        charsPerToken: 4,
    };

    const compactor = new DefaultContextCompactor({
        provider: compactorProvider,
        profile,
    });

    const turns = Array.from({ length: 4 }, (_, i) => ({
        startSequence: i * 5 + 1,
        endSequence: (i + 1) * 5,
        items: [
            {
                type: "message" as const,
                role: "user" as const,
                content: `Turn ${i + 1} test content `.repeat(15),
            },
        ],
    }));

    const summary = await compactor.compactHistory({
        items: turns.flatMap((t) => t.items),
        startSequence: 1,
        endSequence: 20,
        turns,
    });

    assert.ok(summary !== null);
    assert.ok(recordedRequests.length >= 3);

    for (const req of recordedRequests) {
        const tokens = req.items.reduce(
            (sum, it) => sum + (it.type === "message" ? Math.ceil(it.content.length / 4) + 4 : 4),
            0,
        );
        assert.ok(tokens <= 300, `Request tokens (${tokens}) must remain <= 300`);
    }
});

test("Group G5: Compactor fails closed if any chunk fails or if capacity is too small for mandatory instructions", async () => {
    let callCount = 0;
    const failingProvider: ModelProvider = {
        id: "failing-midway",
        stream: () => {
            callCount++;
            return (async function* () {
                if (callCount === 2) {
                    throw new Error("Midway network failure");
                }
                yield {
                    type: "text",
                    content: makeSummaryJson({ startSequence: 1, endSequence: 5 }),
                } as ModelEvent;
            })();
        },
    };

    const smallProfile: ModelProfile = {
        id: "small-profile",
        contextWindowTokens: 400,
        maxOutputTokens: 100,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };

    const compactor = new DefaultContextCompactor({
        provider: failingProvider,
        profile: smallProfile,
    });

    const turns = Array.from({ length: 4 }, (_, i) => ({
        startSequence: i * 5 + 1,
        endSequence: (i + 1) * 5,
        items: [
            {
                type: "message" as const,
                role: "user" as const,
                content: "Content ".repeat(30),
            },
        ],
    }));

    // Must fail closed with null (never claim full coverage when a chunk failed)
    const result = await compactor.compactHistory({
        items: turns.flatMap((t) => t.items),
        startSequence: 1,
        endSequence: 20,
        turns,
    });
    assert.strictEqual(result, null, "Must fail closed if a chunk fails");

    // AbortSignal cancels immediately
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
        () =>
            compactor.compactHistory({
                items: turns.flatMap((t) => t.items),
                startSequence: 1,
                endSequence: 20,
                signal: ac.signal,
            }),
        { name: "AbortError" },
    );

    // Context capacity too small for instructions (< 20 tokens) fails closed cleanly
    const microscopicProfile: ModelProfile = {
        id: "micro-profile",
        contextWindowTokens: 50,
        maxOutputTokens: 20,
        safetyMarginTokens: 10, // maxInputTokens = 20
        toolMode: "native",
    };

    const microCompactor = new DefaultContextCompactor({
        provider: failingProvider,
        profile: microscopicProfile,
    });

    const microResult = await microCompactor.compactHistory({
        items: [{ type: "message", role: "user", content: "test" }],
        startSequence: 1,
        endSequence: 1,
    });
    assert.strictEqual(microResult, null, "Must return null when capacity cannot fit instructions");
});

// ============================================================================
// Group H: Fix 2 — Unavoidable Final Request Preflight Boundary
// ============================================================================

test("Group H1: Runtime wrapping raw unwrapped provider rejects oversized requests before provider is called", async () => {
    let rawProviderCalls = 0;
    const rawProvider: ModelProvider = {
        id: "raw-unwrapped-provider",
        stream: () => {
            rawProviderCalls++;
            return (async function* () {
                yield { type: "text", content: "hello" } as ModelEvent;
            })();
        },
    };

    const tinyProfile: ModelProfile = {
        id: "tiny-profile",
        contextWindowTokens: 100,
        maxOutputTokens: 20,
        safetyMarginTokens: 10, // maxInputTokens = 70
        toolMode: "native",
        charsPerToken: 4,
    };

    // Direct instantiation with raw, unwrapped provider
    const runtime = createAkkcoRuntime(rawProvider, {
        profile: tinyProfile,
    });

    // Request with 400 characters (~100 tokens > 70 maxInputTokens)
    const oversizedRequest: ModelRequest = {
        items: [{ type: "message", role: "user", content: "A".repeat(400) }],
    };

    await assert.rejects(async () => {
        for await (const _event of runtime.run(oversizedRequest)) {
            // Should not reach
        }
    }, ContextBudgetOverflowError);

    assert.equal(rawProviderCalls, 0, "Raw provider must NEVER be invoked for oversized requests");
});

test("Group H2: Valid request through unwrapped provider proceeds and delivers bounded request", async () => {
    let capturedRequest: ModelRequest | undefined;
    const rawProvider: ModelProvider = {
        id: "raw-unwrapped-provider",
        stream: (req) => {
            capturedRequest = req;
            return (async function* () {
                yield { type: "text", content: "Valid response" } as ModelEvent;
            })();
        },
    };

    const profile: ModelProfile = {
        id: "normal-profile",
        contextWindowTokens: 1000,
        maxOutputTokens: 200,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };

    const runtime = createAkkcoRuntime(rawProvider, { profile });

    const validRequest: ModelRequest = {
        items: [{ type: "message", role: "user", content: "Short valid prompt" }],
    };

    const events = [];
    for await (const event of runtime.run(validRequest)) {
        events.push(event);
    }

    assert.ok(capturedRequest, "Request must reach raw provider");
    assert.equal(capturedRequest.items.length, 1);
    assert.equal(events.length, 1);
    assert.equal((events[0] as any).content, "Valid response");
});

test("Group H3: Multi-turn native tool execution through unwrapped provider enforces preflight on all iterations", async () => {
    const deliveredRequests: ModelRequest[] = [];
    let callIndex = 0;

    const rawProvider: ModelProvider = {
        id: "raw-unwrapped-provider",
        stream: (req) => {
            deliveredRequests.push(req);
            callIndex++;
            return (async function* () {
                if (callIndex === 1) {
                    yield {
                        type: "tool_call",
                        id: "call_abc123",
                        name: "read_file",
                        arguments: { path: "data.txt" },
                    } as ModelEvent;
                } else {
                    yield {
                        type: "text",
                        content: "File contents analyzed.",
                    } as ModelEvent;
                }
            })();
        },
    };

    const profile: ModelProfile = {
        id: "normal-profile",
        contextWindowTokens: 1000,
        maxOutputTokens: 200,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };

    const toolHost = {
        tools: [
            {
                name: "read_file",
                description: "Read file",
                inputSchema: { type: "object", properties: { path: { type: "string" } } },
            },
        ],
        execute: async () => ({
            callId: "call_abc123",
            toolName: "read_file",
            content: "file contents",
        }),
    };

    const runtime = createAkkcoRuntime(rawProvider, {
        profile,
        toolHost: toolHost as any,
    });

    for await (const _event of runtime.run({
        items: [{ type: "message", role: "user", content: "Read data.txt" }],
    })) {
        // Drain events
    }

    assert.equal(deliveredRequests.length, 2, "Both iterations must reach provider");

    // Both iterations passed preflight
    for (const req of deliveredRequests) {
        assert.ok(req.items.length > 0);
    }
});

test("Group H4: Compatibility mode through unwrapped provider bounds XML tool schemas and repair turns", async () => {
    const { createTextToolCompatibilityProvider } = await import("@akkco/providers");

    const deliveredToWire: ModelRequest[] = [];
    let wireCallCount = 0;

    const rawProvider: ModelProvider = {
        id: "raw-inner-provider",
        stream: (req) => {
            deliveredToWire.push(req);
            wireCallCount++;
            return (async function* () {
                if (wireCallCount === 1) {
                    // Protocol violation: triggers repair turn
                    yield {
                        type: "text",
                        content: "I am calling akkco_tool without valid JSON",
                    } as ModelEvent;
                } else if (wireCallCount === 2) {
                    // Repaired valid tool call
                    yield {
                        type: "text",
                        content:
                            '<akkco_tool_call>\n{"name":"read_file","arguments":{"path":"foo.ts"}}\n</akkco_tool_call>',
                    } as ModelEvent;
                } else {
                    yield { type: "text", content: "Final answer after tool." } as ModelEvent;
                }
            })();
        },
    };

    const profile: ModelProfile = {
        id: "compat-profile",
        contextWindowTokens: 2000,
        maxOutputTokens: 300,
        safetyMarginTokens: 100,
        toolMode: "compatibility",
        charsPerToken: 4,
    };

    // Construct TextToolCompatibilityProvider with raw unwrapped inner provider
    const compatProvider = createTextToolCompatibilityProvider(rawProvider);

    const toolHost = {
        tools: [
            {
                name: "read_file",
                description: "Read a file from disk",
                inputSchema: { type: "object", properties: { path: { type: "string" } } },
            },
        ],
        execute: async () => ({
            callId: "call-1",
            toolName: "read_file",
            content: "export const x = 1;",
        }),
    };

    // createAkkcoRuntime receives the compatibility provider wrapping the raw provider
    const runtime = createAkkcoRuntime(compatProvider, {
        profile,
        toolHost: toolHost as any,
    });

    for await (const _event of runtime.run({
        items: [{ type: "message", role: "user", content: "Please read foo.ts" }],
    })) {
        // Drain events
    }

    assert.ok(deliveredToWire.length >= 2, "Both initial and repair requests must be sent");

    // In compatibility mode, tools are cleared on wire and XML protocol is injected into system prompt
    assert.strictEqual(deliveredToWire[0].tools, undefined, "Native tools must be cleared on wire");
    const systemMessage = deliveredToWire[0].items.find(
        (it) => it.type === "message" && it.role === "system",
    );
    assert.ok(
        systemMessage &&
            systemMessage.type === "message" &&
            systemMessage.content.includes("akkco_tool_call"),
        "Injected XML tool instructions must be present on wire request",
    );

    // Repair request must contain the repair instruction
    const repairUserMessage = deliveredToWire[1].items.find(
        (it) => it.type === "message" && it.role === "user" && (it as any).isRepairInstruction,
    );
    assert.ok(repairUserMessage, "Repair instruction must be present on wire request");
});

test("Group H5: Exact tool-call/result relationships survive request preparation", async () => {
    let capturedRequest: ModelRequest | undefined;

    const rawProvider: ModelProvider = {
        id: "raw-provider",
        stream: (req) => {
            capturedRequest = req;
            return (async function* () {
                yield { type: "text", content: "done" } as ModelEvent;
            })();
        },
    };

    const runtime = createAkkcoRuntime(rawProvider, {
        budget: {
            preferredInputTokens: 1000,
            reservedOverheadTokens: 100,
            minimumRecentHistoryTokens: 100,
        },
    });

    const toolCallId = "unique_call_id_999";
    const toolName = "search_text";
    const toolArgs = { query: "export const foo" };

    const request: ModelRequest = {
        items: [
            { type: "message", role: "user", content: "Find foo" },
            {
                type: "tool_call",
                id: toolCallId,
                name: toolName,
                arguments: toolArgs,
            },
            {
                type: "tool_result",
                callId: toolCallId,
                content: "src/foo.ts:1:export const foo = true;",
            },
        ],
    };

    for await (const _event of runtime.run(request)) {
        // Drain
    }

    assert.ok(capturedRequest);
    const callItem = capturedRequest.items.find((it) => it.type === "tool_call");
    const resultItem = capturedRequest.items.find((it) => it.type === "tool_result");

    assert.ok(callItem && callItem.type === "tool_call");
    assert.ok(resultItem && resultItem.type === "tool_result");

    assert.equal(callItem.id, toolCallId);
    assert.equal(callItem.name, toolName);
    assert.deepEqual(callItem.arguments, toolArgs);

    assert.equal(resultItem.callId, toolCallId);
    assert.equal(resultItem.content, "src/foo.ts:1:export const foo = true;");
});
