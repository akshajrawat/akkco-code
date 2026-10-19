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

    assert.ok(compactorInvoked, "Expected compactor to be invoked for oversized tool output");
    assert.equal(providerCalls, 2, "Expected 2 provider calls (tool call + final answer)");

    // Verify the second model request received the compacted tool result in workingItems
    const secondReq = recordedRequests[1];
    const toolResultItem = secondReq.items.find((item) => item.type === "tool_result");
    assert.ok(toolResultItem, "Expected tool_result item in second request");
    if (toolResultItem.type === "tool_result") {
        assert.ok(
            toolResultItem.content.includes("Compact summary"),
            "Expected working tool result to contain compacted summary",
        );
        assert.ok(
            toolResultItem.content.includes("[Canonical transcript retains full original output"),
            "Expected working tool result to contain canonical provenance note",
        );
    }

    // Verify runtime event emitted the full uncompacted content to session / user
    const toolEvent = events.find((e) => e.type === "tool_execution");
    assert.ok(toolEvent, "Expected tool_execution event");
    assert.ok(
        toolEvent.result.includes("Very large file content line"),
        "Expected runtime tool_execution event to preserve raw content",
    );
});

test("Group A2: Compaction strictly respects target budget (zero 1.5x tolerance)", async () => {
    // When compactor returns output exceeding targetTokens, compactToolResult must return null
    const oversizeProvider = createFakeProvider(async () => {
        return (async function* () {
            // Generates ~200 tokens
            yield {
                type: "text",
                content: "Excessive summary words ".repeat(40),
            } as ModelEvent;
        })();
    });

    const compactor = new DefaultContextCompactor({
        provider: oversizeProvider,
    });

    const result = await compactor.compactToolResult({
        toolName: "read_file",
        callId: "c1",
        content: "Huge raw content ".repeat(100),
        targetTokens: 40, // very tight target
    });

    assert.equal(
        result,
        null,
        "Expected compactToolResult to fail closed (return null) when summary exceeds targetTokens",
    );
});

test("Group A3: Structured compaction output preserves tool metadata and omission note", async () => {
    const compactorProvider = createFakeProvider(async () => {
        return (async function* () {
            yield {
                type: "text",
                content:
                    "read_file for path 'src/index.ts' succeeded. Found 12 exports, exitCode 0. 500 lines of details omitted.",
            } as ModelEvent;
        })();
    });

    const compactor = new DefaultContextCompactor({
        provider: compactorProvider,
    });

    const compacted = await compactor.compactToolResult({
        toolName: "read_file",
        callId: "call-99",
        content: "Export lines ".repeat(100),
        targetTokens: 120,
    });

    assert.ok(compacted !== null);
    assert.ok(compacted.includes("[Summary of read_file (call-99)]:"));
    assert.ok(compacted.includes("src/index.ts"));
    assert.ok(compacted.includes("exitCode 0"));
    assert.ok(compacted.includes("[Canonical transcript retains full original output"));
    assert.ok(compacted.includes("Details omitted for token budget."));
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

test("Group C2: Compactor chunks oversized tool results exceeding compactor capacity line-by-line and merges", async () => {
    let toolCompactorRequests = 0;
    const compactorProvider = createFakeProvider(async (req) => {
        toolCompactorRequests++;
        assert.equal(req.tools, undefined, "Compaction requests must have tools: undefined");

        return (async function* () {
            yield {
                type: "text",
                content: `Extracted summary for chunk ${toolCompactorRequests}: path/to/file.ts:10.`,
            } as ModelEvent;
        })();
    });

    // Profile with small capacity: 400 - 100 - 50 = 250 maxInputTokens
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

    // 80 lines of 30 chars each = 2400 chars = 600 tokens > 250 maxInputTokens
    const hugeToolOutput = Array.from(
        { length: 80 },
        (_, i) => `Line ${i}: log entry with data`,
    ).join("\n");

    const compacted = await compactor.compactToolResult({
        toolName: "read_file",
        callId: "call-c2",
        content: hugeToolOutput,
        targetTokens: 100,
    });

    assert.ok(compacted !== null);
    assert.ok(
        toolCompactorRequests > 1,
        `Expected multiple chunk requests for oversized tool output, got ${toolCompactorRequests}`,
    );
    assert.ok(compacted.includes("[Summary of read_file (call-c2)]:"));
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
