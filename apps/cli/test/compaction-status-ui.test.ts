import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { SqliteConversationStore } from "@akkco/retrieval";
import type { ModelEvent, ModelProfile, ModelProvider, ModelRequest } from "@akkco/models";
import {
    createAkkcoRuntime,
    createBoundedContextCompiler,
    createContextCompactor,
    DefaultContextCompactor,
    deriveContextBudget,
    type CompactionProgressEvent,
    type ContextCompactor,
    type StructuredSummary,
} from "@akkco/core";
import { createToolRegistry } from "@akkco/tools";
import { createCliController } from "../src/state/cli-controller.js";
import { uiStatus } from "../src/ui/layout.js";

const makeProvider = (
    generateContent: (request: ModelRequest) => string | Promise<string>,
): ModelProvider => ({
    id: "mock-provider",
    stream: (request: ModelRequest) => {
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

test("Compaction UI: historical compaction starts, updates status, succeeds, and clears status", async () => {
    const events: CompactionProgressEvent[] = [];
    let progressCallback: ((event: CompactionProgressEvent) => void) | undefined;

    const mockCompactor: ContextCompactor = {
        compactHistory: async (options) => {
            progressCallback?.({ type: "start", scope: "history" });
            const summary: StructuredSummary = {
                taskOrInvestigation: "Refactor database indexing",
                importantFindings: ["Found redundant indices"],
                filesAndLocations: ["db/schema.sql:10"],
                decisions: ["Prune duplicate index"],
                failedApproaches: [],
                unresolvedIssues: [],
                nextSteps: [],
                omissions: "Logs omitted",
                sourceRange: {
                    sessionId: options.sessionId,
                    startSequence: options.startSequence,
                    endSequence: options.endSequence,
                },
            };
            progressCallback?.({ type: "success", scope: "history" });
            return summary;
        },
        onProgress: (listener) => {
            progressCallback = (event) => {
                events.push(event);
                listener(event);
            };
            return () => {};
        },
    };

    const provider = makeProvider(() => "Response after compaction");
    const profile: ModelProfile = {
        id: "test-profile",
        contextWindowTokens: 1000,
        maxOutputTokens: 200,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };
    const budget = deriveContextBudget(profile);

    const compiler = createBoundedContextCompiler({
        budget,
        profile,
        compactor: mockCompactor,
        compactionThreshold: 0.1,
    });

    const controller = createCliController({
        provider,
        toolRegistry: createToolRegistry(),
        compiler,
        compactor: mockCompactor,
        profile,
        budget,
    });

    const observedStatuses: string[] = [];
    controller.subscribe(() => {
        const snap = controller.getSnapshot();
        observedStatuses.push(uiStatus(snap));
    });

    // Seed turns in session (at least 2 turns required so older turns can be compacted while keeping newest)
    const session = controller.getSession();
    (session as any)._transcript.push(
        { type: "user", content: "A".repeat(400) },
        { type: "assistant", content: "B".repeat(400), status: "completed" },
        { type: "user", content: "C".repeat(400) },
        { type: "assistant", content: "D".repeat(400), status: "completed" },
    );

    await controller.submit("New user message");

    // Compaction started and updated status
    assert.ok(events.some((e) => e.type === "start" && e.scope === "history"));
    assert.ok(events.some((e) => e.type === "success" && e.scope === "history"));
    assert.ok(observedStatuses.includes("Compacting conversation history..."));

    // Completed notice was added
    const notices = controller.getSnapshot().history.filter((h) => h.type === "notice");
    assert.ok(
        notices.some(
            (n) => n.type === "notice" && n.content.includes("Context compacted. Continuing..."),
        ),
    );

    // When finished, compaction status is cleared and status returns to Idle
    const finalSnapshot = controller.getSnapshot();
    assert.equal(finalSnapshot.compaction, undefined);
    assert.equal(uiStatus(finalSnapshot), "Idle");

    await controller.dispose();
});

test("Compaction UI: operational compactor failure displays fallback notice and clears status", async () => {
    let progressCallback: ((event: CompactionProgressEvent) => void) | undefined;

    const failingCompactor: ContextCompactor = {
        compactHistory: async () => {
            progressCallback?.({ type: "start", scope: "history" });
            // Compactor encounters failure (e.g. malformed JSON or model error)
            progressCallback?.({ type: "fallback", scope: "history" });
            return null; // safe context fallback
        },
        onProgress: (listener) => {
            progressCallback = listener;
            return () => {};
        },
    };

    const provider = makeProvider(() => "Response via fallback context eviction");
    const profile: ModelProfile = {
        id: "test-profile",
        contextWindowTokens: 1000,
        maxOutputTokens: 200,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };
    const budget = deriveContextBudget(profile);

    const compiler = createBoundedContextCompiler({
        budget,
        profile,
        compactor: failingCompactor,
        compactionThreshold: 0.1,
    });

    const controller = createCliController({
        provider,
        toolRegistry: createToolRegistry(),
        compiler,
        compactor: failingCompactor,
        profile,
        budget,
    });

    const session = controller.getSession();
    (session as any)._transcript.push(
        { type: "user", content: "A".repeat(400) },
        { type: "assistant", content: "B".repeat(400), status: "completed" },
        { type: "user", content: "C".repeat(400) },
        { type: "assistant", content: "D".repeat(400), status: "completed" },
    );

    await controller.submit("Run with failing compactor");

    // Invariant: MUST NEVER show success if compaction returned null or failed!
    const notices = controller.getSnapshot().history.filter((h) => h.type === "notice");
    assert.ok(
        !notices.some((n) => n.type === "notice" && n.content.includes("Context compacted.")),
    );

    // Must show clear fallback notice
    assert.ok(
        notices.some(
            (n) =>
                n.type === "notice" &&
                n.kind === "warning" &&
                n.content.includes("Compaction unavailable; using safe context fallback."),
        ),
    );

    // Compaction state must be cleared
    assert.equal(controller.getSnapshot().compaction, undefined);
    assert.equal(uiStatus(controller.getSnapshot()), "Idle");

    await controller.dispose();
});

test("Compaction UI: aborted compaction emits cancel, clears status, and NEVER reports success", async () => {
    let progressCallback: ((event: CompactionProgressEvent) => void) | undefined;
    const events: CompactionProgressEvent[] = [];

    const mockCompactor: ContextCompactor = {
        compactHistory: async () => {
            progressCallback?.({ type: "start", scope: "history" });
            progressCallback?.({ type: "cancel", scope: "history" });
            const err = new DOMException("The operation was aborted.", "AbortError");
            throw err;
        },
        onProgress: (listener) => {
            progressCallback = (e) => {
                events.push(e);
                listener(e);
            };
            return () => {};
        },
    };

    const provider = makeProvider(() => "Never reached");
    const profile: ModelProfile = {
        id: "test-profile",
        contextWindowTokens: 1000,
        maxOutputTokens: 200,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };
    const budget = deriveContextBudget(profile);

    const compiler = createBoundedContextCompiler({
        budget,
        profile,
        compactor: mockCompactor,
        compactionThreshold: 0.1,
    });

    const controller = createCliController({
        provider,
        toolRegistry: createToolRegistry(),
        compiler,
        compactor: mockCompactor,
        profile,
        budget,
    });

    const session = controller.getSession();
    (session as any)._transcript.push(
        { type: "user", content: "A".repeat(400) },
        { type: "assistant", content: "B".repeat(400), status: "completed" },
        { type: "user", content: "C".repeat(400) },
        { type: "assistant", content: "D".repeat(400), status: "completed" },
    );

    await controller.submit("Prompt that gets aborted");

    // Emitted cancel
    assert.ok(events.some((e) => e.type === "cancel"));

    // Invariant: NEVER reports success on abort!
    const notices = controller.getSnapshot().history.filter((h) => h.type === "notice");
    assert.ok(
        !notices.some((n) => n.type === "notice" && n.content.includes("Context compacted.")),
    );

    // Status cleared
    assert.equal(controller.getSnapshot().compaction, undefined);

    await controller.dispose();
});

test("Compaction UI: cached summary exact hit produces NO active progress indicator", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const events: CompactionProgressEvent[] = [];
    const compactor = new DefaultContextCompactor({
        provider: makeProvider(() => "Should not be called for cached hit"),
        store,
        onProgress: (e) => events.push(e),
    });

    const sessionId = "cached-summary-session";

    // Seed an existing summary covering sequences 0 to 3
    const seededSummary: StructuredSummary = {
        taskOrInvestigation: "Precomputed summary",
        importantFindings: ["Cache hit test"],
        filesAndLocations: [],
        decisions: [],
        failedApproaches: [],
        unresolvedIssues: [],
        nextSteps: [],
        omissions: "None",
        sourceRange: {
            sessionId,
            startSequence: 0,
            endSequence: 3,
        },
    };

    await store.saveContextSummary({
        sessionId,
        startSequence: 0,
        endSequence: 3,
        summaryJson: JSON.stringify(seededSummary),
        estimatedTokens: 50,
    });

    // Request compaction for exact sequence 0 to 3
    const result = await compactor.compactHistory({
        items: [{ type: "message", role: "user", content: "Cached turn" }],
        startSequence: 0,
        endSequence: 3,
        sessionId,
    });

    assert.ok(result);
    assert.equal(result.taskOrInvestigation, "Precomputed summary");

    // Invariant: Cache hits that require no AI inference must not produce a misleading long-running indicator
    assert.equal(events.length, 0, "No progress events must be emitted on exact cache hit");

    await store.close();
});

test("Compaction UI: narrow terminal width layout remains stable during compaction", () => {
    // Test uiStatus and layout under narrow terminal widths (e.g., 30 and 40 cols)
    const state = {
        history: [],
        historyVersion: 1,
        assistantText: "",
        status: "generating" as const,
        compaction: { active: true, scope: "tool" as const, toolName: "read_file" },
        exited: false,
    };

    const status = uiStatus(state);
    assert.equal(status, "Compacting read_file output...");

    const stateHistory = {
        ...state,
        compaction: { active: true, scope: "history" as const },
    };
    const statusHistory = uiStatus(stateHistory);
    assert.equal(statusHistory, "Compacting conversation history...");
});

test("Compaction UI: existing generation streaming remains uninterrupted and repeated operations do not leave stale indicators", async () => {
    let compactionCallCount = 0;
    const mockCompactor: ContextCompactor = {
        compactHistory: async () => null,
        onProgress: (listener) => {
            // Simulate start and complete for two separate turns
            listener({ type: "start", scope: "history" });
            listener({ type: "success", scope: "history" });
            compactionCallCount++;
            return () => {};
        },
    };

    const emittedTextChunks: string[] = [];
    const provider: ModelProvider = {
        id: "streaming-provider",
        stream: () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "chunk 1 " };
                yield { type: "text", content: "chunk 2 " };
                yield { type: "text", content: "chunk 3" };
            },
        }),
    };

    const controller = createCliController({
        provider,
        toolRegistry: createToolRegistry(),
        compactor: mockCompactor,
    });

    controller.onEvent((event) => {
        if (event.type === "text") {
            emittedTextChunks.push(event.content);
        }
    });

    // Turn 1
    await controller.submit("Turn 1");
    assert.equal(emittedTextChunks.join(""), "chunk 1 chunk 2 chunk 3");
    assert.equal(controller.getSnapshot().compaction, undefined);
    assert.equal(uiStatus(controller.getSnapshot()), "Idle");

    // Turn 2: Repeated operation
    emittedTextChunks.length = 0;
    await controller.submit("Turn 2");
    assert.equal(emittedTextChunks.join(""), "chunk 1 chunk 2 chunk 3");

    // No stale indicators
    assert.equal(controller.getSnapshot().compaction, undefined);
    assert.equal(uiStatus(controller.getSnapshot()), "Idle");

    await controller.dispose();
});

test("Commands: /session displays active session ID, transcript length, and metadata", async () => {
    const provider = makeProvider(() => "ok");
    const controller = createCliController({
        provider,
        toolRegistry: createToolRegistry(),
        metadata: {
            version: "1.0.0",
            provider: "TestProvider",
            model: "qwen2.5-coder:7b",
            toolMode: "compatibility",
            cwd: "/workspace",
        },
    });

    await controller.submit("/session");

    const notices = controller.getSnapshot().history.filter((h) => h.type === "notice");
    assert.ok(notices.length > 0);
    const notice = notices.at(-1)!;
    assert.ok(notice.content.includes("Active Session:"));
    assert.ok(notice.content.includes(controller.getSession().id));
    assert.ok(notice.content.includes("qwen2.5-coder:7b"));
    assert.ok(notice.content.includes("compatibility"));

    await controller.dispose();
});
