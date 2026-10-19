import assert from "node:assert/strict";
import test from "node:test";
import type {
    ModelEvent,
    ModelItem,
    ModelProfile,
    ModelProvider,
    ModelRequest,
} from "@akkco/models";
import { SqliteConversationStore } from "@akkco/retrieval";
import {
    createBoundedContextCompiler,
    createContextCompactor,
    DefaultContextCompactor,
    deriveContextBudget,
    formatSummaryAsModelItem,
    validateStructuredSummary,
    type StructuredSummary,
    type TranscriptItem,
} from "../src/index.js";

const makeProvider = (
    generateContent: (request: ModelRequest) => string | Promise<string>,
    onCall?: (request: ModelRequest) => void,
): ModelProvider => ({
    id: "mock-provider",
    stream: (request: ModelRequest) => {
        onCall?.(request);
        return {
            async *[Symbol.asyncIterator]() {
                if (request.signal?.aborted) {
                    throw new DOMException("The operation was aborted.", "AbortError");
                }
                const content = await generateContent(request);
                yield { type: "text", content } satisfies ModelEvent;
            },
        };
    },
});

test("Phase B: validateStructuredSummary validates valid payload and rejects malformed fields", () => {
    const valid: StructuredSummary = {
        taskOrInvestigation: "Investigate database query latency",
        importantFindings: ["Missing index on session_id column"],
        filesAndLocations: ["packages/retrieval/src/store.ts:42"],
        decisions: ["Add compound index on (session_id, start_sequence)"],
        failedApproaches: ["Single column index did not optimize range queries"],
        unresolvedIssues: ["Need to verify performance on SQLite WAL mode"],
        nextSteps: ["Benchmark 10k messages"],
        omissions: "Intermediate query plans omitted",
        sourceRange: {
            sessionId: "session-1",
            startSequence: 0,
            endSequence: 5,
        },
    };

    assert.deepStrictEqual(validateStructuredSummary(valid), valid);

    // Reject non-objects
    assert.throws(() => validateStructuredSummary(null), TypeError);
    assert.throws(() => validateStructuredSummary("string"), TypeError);

    // Reject missing taskOrInvestigation
    assert.throws(
        () => validateStructuredSummary({ ...valid, taskOrInvestigation: "" }),
        TypeError,
    );

    // Reject non-array findings
    assert.throws(
        () => validateStructuredSummary({ ...valid, importantFindings: "not an array" }),
        TypeError,
    );

    // Reject invalid sourceRange
    assert.throws(
        () =>
            validateStructuredSummary({
                ...valid,
                sourceRange: { startSequence: "zero", endSequence: 5 },
            }),
        TypeError,
    );
});

test("Phase B: formatSummaryAsModelItem formats summary as untrusted background context", () => {
    const summary: StructuredSummary = {
        taskOrInvestigation: "Fix memory leak in websocket server",
        importantFindings: ["Unclosed socket handles in idle connections"],
        filesAndLocations: ["src/ws.ts:100"],
        decisions: ["Implement heartbeat ping-pong with timeout"],
        failedApproaches: [],
        unresolvedIssues: [],
        nextSteps: ["Deploy to canary"],
        omissions: "Debug traces omitted",
        sourceRange: {
            sessionId: "sess-abc",
            startSequence: 0,
            endSequence: 3,
        },
    };

    const item = formatSummaryAsModelItem(summary);
    assert.strictEqual(item.type, "message");
    assert.strictEqual(item.role, "user");
    assert.strictEqual(item.isPolicy, false);
    assert.ok(item.content.includes("Historical context summary"));
    assert.ok(item.content.includes("Fix memory leak in websocket server"));
    assert.ok(item.content.includes("Unclosed socket handles in idle connections"));
    assert.ok(item.content.includes("Debug traces omitted"));
    assert.strictEqual(item.provenance?.source, "history");
    assert.strictEqual(item.provenance?.documents?.[0]?.startSequence, 0);
    assert.strictEqual(item.provenance?.documents?.[0]?.endSequence, 3);
});

test("Phase B: compactor sends tools: undefined (non-recursive) and accepts valid structured summary", async () => {
    let capturedRequest: ModelRequest | undefined;

    const sampleSummary: StructuredSummary = {
        taskOrInvestigation: "Refactor auth middleware",
        importantFindings: ["JWT validation was blocking event loop"],
        filesAndLocations: ["packages/server/src/auth.ts:15"],
        decisions: ["Move crypto checks to async worker thread"],
        failedApproaches: ["In-process caching had race conditions"],
        unresolvedIssues: [],
        nextSteps: ["Write worker pool unit tests"],
        omissions: "Test tokens omitted",
        sourceRange: {
            sessionId: "s1",
            startSequence: 0,
            endSequence: 2,
        },
    };

    const provider = makeProvider(
        () => JSON.stringify(sampleSummary),
        (req) => {
            capturedRequest = req;
        },
    );

    const compactor = new DefaultContextCompactor({ provider });

    const items: ModelItem[] = [
        { type: "message", role: "user", content: "Can you inspect auth middleware?" },
        { type: "message", role: "assistant", content: "Sure, let me check." },
    ];

    const result = await compactor.compactHistory({
        items,
        startSequence: 0,
        endSequence: 2,
        sessionId: "s1",
    });

    assert.ok(result);
    assert.strictEqual(result.taskOrInvestigation, sampleSummary.taskOrInvestigation);
    assert.deepStrictEqual(result.importantFindings, sampleSummary.importantFindings);

    // Verify compactor non-recursiveness: tools must be undefined
    assert.strictEqual(capturedRequest?.tools, undefined);
    // Verify system instruction is present for compaction
    assert.ok(capturedRequest?.items.some((it) => it.type === "message" && it.role === "system"));
});

test("Phase B: compactor rejects malformed JSON and falls back cleanly to null", async () => {
    const provider = makeProvider(() => "I am not returning valid JSON at all!");
    const compactor = createContextCompactor({ provider });

    const result = await compactor.compactHistory({
        items: [{ type: "message", role: "user", content: "hello" }],
        startSequence: 0,
        endSequence: 1,
    });

    assert.strictEqual(result, null);
});

test("Phase B: compactor rejects oversized summaries that exceed maxSummaryTokens", async () => {
    // Return a valid JSON, but excessively long (e.g. 1000 tokens when limit is 100 tokens)
    const longString = "A".repeat(4000);
    const oversizedSummary: StructuredSummary = {
        taskOrInvestigation: longString,
        importantFindings: [longString],
        filesAndLocations: [],
        decisions: [],
        failedApproaches: [],
        unresolvedIssues: [],
        nextSteps: [],
        omissions: "none",
        sourceRange: { startSequence: 0, endSequence: 1 },
    };

    const provider = makeProvider(() => JSON.stringify(oversizedSummary));
    const compactor = createContextCompactor({
        provider,
        maxSummaryTokens: 100, // Strict limit
    });

    const result = await compactor.compactHistory({
        items: [{ type: "message", role: "user", content: "test" }],
        startSequence: 0,
        endSequence: 1,
    });

    assert.strictEqual(result, null);
});

test("Phase B: summary persistence in SQLite store and reuse across invocations", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    let providerCalls = 0;
    const sampleSummary: StructuredSummary = {
        taskOrInvestigation: "Database migration 0002",
        importantFindings: ["Added context_summaries table"],
        filesAndLocations: ["packages/retrieval/migrations/0002_context_summaries.sql"],
        decisions: ["Store JSON structured summary with sequence bounds"],
        failedApproaches: [],
        unresolvedIssues: [],
        nextSteps: ["Add SQLite store methods"],
        omissions: "None",
        sourceRange: {
            sessionId: "session-xyz",
            startSequence: 0,
            endSequence: 4,
        },
    };

    const provider = makeProvider(() => {
        providerCalls++;
        return JSON.stringify(sampleSummary);
    });

    const compactor = createContextCompactor({
        provider,
        store,
    });

    const items: ModelItem[] = [
        { type: "message", role: "user", content: "Turn 0" },
        { type: "message", role: "assistant", content: "Turn 1" },
    ];

    // First call: calls provider and persists in SQLite
    const firstResult = await compactor.compactHistory({
        items,
        startSequence: 0,
        endSequence: 4,
        sessionId: "session-xyz",
    });

    assert.ok(firstResult);
    assert.strictEqual(providerCalls, 1);

    // Verify stored in SQLite directly
    const saved = await store.findContextSummary("session-xyz", 0, 4);
    assert.ok(saved);
    assert.strictEqual(saved.startSequence, 0);
    assert.strictEqual(saved.endSequence, 4);

    // Second call: loads from SQLite without calling provider again!
    const secondResult = await compactor.compactHistory({
        items,
        startSequence: 0,
        endSequence: 4,
        sessionId: "session-xyz",
    });

    assert.ok(secondResult);
    assert.strictEqual(providerCalls, 1, "Provider should not be called when cached in SQLite");
    assert.deepStrictEqual(secondResult, firstResult);
});

test("Phase B: compaction triggers when context usage exceeds threshold (~80%) in BoundedContextCompiler", async () => {
    let compactionCalled = 0;
    const summaryData: StructuredSummary = {
        taskOrInvestigation: "Initial project setup",
        importantFindings: ["TypeScript and test runners configured"],
        filesAndLocations: ["package.json"],
        decisions: ["Use standard node:test"],
        failedApproaches: [],
        unresolvedIssues: [],
        nextSteps: ["Implement core modules"],
        omissions: "Verbose log outputs omitted",
        sourceRange: {
            sessionId: "compaction-test-session",
            startSequence: 0,
            endSequence: 3,
        },
    };

    const provider = makeProvider(() => {
        compactionCalled++;
        return JSON.stringify(summaryData);
    });

    const compactor = createContextCompactor({ provider });

    // Budget: 1000 input tokens. Compaction threshold = 0.8 (800 tokens).
    const budget = {
        preferredInputTokens: 1000,
        minimumRecentHistoryTokens: 250,
        maximumMemoryTokens: 300,
        maximumRepositoryTokens: 300,
        reservedOverheadTokens: 0,
    };

    const compiler = createBoundedContextCompiler({
        budget,
        compactor,
        compactionThreshold: 0.8,
        sessionId: "compaction-test-session",
    });

    // Create a transcript with multiple completed turns totaling ~900 tokens (> 800 tokens)
    // 1 token ≈ 4 chars. 350 tokens ≈ 1400 chars.
    const turn1User = "Turn 1 user request: " + "A".repeat(800); // ~200 tokens
    const turn1Assistant = "Turn 1 assistant answer: " + "B".repeat(800); // ~200 tokens
    const turn2User = "Turn 2 user request: " + "C".repeat(800); // ~200 tokens
    const turn2Assistant = "Turn 2 assistant answer: " + "D".repeat(800); // ~200 tokens
    const turn3User = "Turn 3 user prompt: " + "E".repeat(400); // ~100 tokens

    const transcript: TranscriptItem[] = [
        { type: "user", content: turn1User },
        { type: "assistant", content: turn1Assistant, status: "completed" },
        { type: "user", content: turn2User },
        { type: "assistant", content: turn2Assistant, status: "completed" },
        { type: "user", content: turn3User },
    ];

    // Make a copy to test losslessness
    const originalTranscriptCopy = JSON.parse(JSON.stringify(transcript));

    const compiled = await compiler.compile(transcript, {
        sessionId: "compaction-test-session",
    });

    // 1. Compactor was triggered!
    assert.strictEqual(compactionCalled, 1);

    // 2. Canonical transcript was NOT modified (lossless)
    assert.deepStrictEqual(transcript, originalTranscriptCopy);

    // 3. Compiled items contain:
    //    - policy system message
    //    - compacted summary message
    //    - newest historical turn (Turn 2)
    //    - active turn (Turn 3)
    const summaryItem = compiled.find(
        (it) => it.type === "message" && it.content.includes("Historical context summary"),
    );
    assert.ok(summaryItem, "Expected a compacted summary item in compiled context");
    assert.ok(
        summaryItem.type === "message" && summaryItem.content.includes("Initial project setup"),
    );

    // Verify Turn 2 (newest historical turn) is preserved for conversational continuity
    const turn2Preserved = compiled.some(
        (it) => it.type === "message" && it.content.includes("Turn 2 user request"),
    );
    assert.ok(turn2Preserved, "Newest historical turn should be preserved for turn continuity");

    // Verify Turn 1 was compacted and replaced by the summary
    const turn1Present = compiled.some(
        (it) => it.type === "message" && it.content.includes("Turn 1 user request"),
    );
    assert.strictEqual(turn1Present, false, "Older turn 1 should be compacted away");
});

test("Phase B: compactor failure gracefully degrades to standard eviction without history corruption", async () => {
    // Provider fails with network error
    const provider: ModelProvider = {
        id: "failing-provider",
        stream: () => {
            throw new Error("Temporary network timeout");
        },
    };

    const compactor = createContextCompactor({ provider });

    const budget = {
        preferredInputTokens: 500,
        minimumRecentHistoryTokens: 125,
        maximumMemoryTokens: 150,
        maximumRepositoryTokens: 150,
        reservedOverheadTokens: 0,
    };

    const compiler = createBoundedContextCompiler({
        budget,
        compactor,
        compactionThreshold: 0.8,
    });

    const transcript: TranscriptItem[] = [
        { type: "user", content: "Turn 1: " + "X".repeat(600) },
        { type: "assistant", content: "Turn 1 reply: " + "Y".repeat(600), status: "completed" },
        { type: "user", content: "Turn 2: " + "Z".repeat(600) },
        { type: "assistant", content: "Turn 2 reply: " + "W".repeat(600), status: "completed" },
        { type: "user", content: "Active turn prompt" },
    ];

    // Compilation must not crash when compactor fails
    const compiled = await compiler.compile(transcript);
    assert.ok(compiled.length > 0);

    // Active turn is preserved
    const activeItem = compiled.find(
        (it) => it.type === "message" && it.content === "Active turn prompt",
    );
    assert.ok(activeItem);

    // No summary was included since compaction failed
    const summaryItem = compiled.find(
        (it) => it.type === "message" && it.content.includes("Historical context summary"),
    );
    assert.strictEqual(summaryItem, undefined);
});

test("Phase B: AbortSignal aborts compactor and compiler with AbortError", async () => {
    const abortController = new AbortController();
    abortController.abort(); // already aborted

    const provider = makeProvider(() => "Should not be reached");
    const compactor = createContextCompactor({ provider });

    const compiler = createBoundedContextCompiler({
        budget: {
            preferredInputTokens: 500,
            minimumRecentHistoryTokens: 125,
            maximumMemoryTokens: 150,
            maximumRepositoryTokens: 150,
            reservedOverheadTokens: 0,
        },
        compactor,
        compactionThreshold: 0.5,
    });

    const transcript: TranscriptItem[] = [
        { type: "user", content: "Turn 1: " + "A".repeat(800) },
        { type: "assistant", content: "Turn 1 reply: " + "B".repeat(800), status: "completed" },
        { type: "user", content: "Active prompt" },
    ];

    await assert.rejects(
        async () => {
            await compiler.compile(transcript, { signal: abortController.signal });
        },
        (error: unknown) => {
            return (
                (error instanceof DOMException && error.name === "AbortError") ||
                (error instanceof Error && error.name === "AbortError")
            );
        },
    );
});
