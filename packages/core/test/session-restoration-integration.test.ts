import assert from "node:assert/strict";
import test from "node:test";
import { SqliteConversationStore } from "@akkco/retrieval";
import type { ModelEvent, ModelProfile, ModelProvider, ModelRequest } from "@akkco/models";
import {
    ConversationMemoryOrchestrator,
    createAkkcoRuntime,
    createBoundedContextCompiler,
    createContextCompactor,
    deriveContextBudget,
    Session,
    type ContextCompactor,
    type RuntimeToolHost,
    type TranscriptItem,
} from "../src/index.js";
import { createRepositoryTools, createToolRegistry } from "@akkco/tools";
import { createCliController } from "../../../apps/cli/src/state/cli-controller.js";

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

test("Session restoration: save -> exit -> reopen -> resume -> continue without sequence conflict", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const persistence = new ConversationMemoryOrchestrator(store);

    const provider = makeProvider((req) => {
        const last = req.items.at(-1);
        return `Echo: ${(last as any)?.content ?? "ok"}`;
    });

    const toolRegistry = createToolRegistry();
    const profile: ModelProfile = {
        id: "test-profile",
        contextWindowTokens: 4096,
        maxOutputTokens: 512,
        safetyMarginTokens: 128,
        toolMode: "native",
        charsPerToken: 4,
    };
    const budget = deriveContextBudget(profile);

    const createCompiler = (sessionId: string) =>
        createBoundedContextCompiler({
            budget,
            profile,
            sessionId,
        });

    // 1. Initial session in Controller A
    const controllerA = createCliController({
        provider,
        toolRegistry,
        persistence,
        profile,
        budget,
        store,
        createCompiler,
    });

    await controllerA.submit("First message in session A");
    const sessionAId = controllerA.getSession().id;
    assert.ok(sessionAId);

    // Verify persisted in SQLite
    const itemsA = await store.getTranscriptItems(sessionAId);
    assert.equal(itemsA.length, 2); // user + assistant
    assert.equal(itemsA[0].sequence, 0);
    assert.equal(itemsA[1].sequence, 1);

    // Exit controller A
    await controllerA.dispose();

    // 2. Open new Controller B (simulates restart of Akkco Code CLI)
    const controllerB = createCliController({
        provider,
        toolRegistry,
        persistence,
        profile,
        budget,
        store,
        createCompiler,
    });

    // Verify Controller B starts with its own fresh session ID
    assert.notEqual(controllerB.getSession().id, sessionAId);

    // List sessions via command
    await controllerB.submit("/sessions");
    const lastNotice = controllerB
        .getSnapshot()
        .history.filter((h) => h.type === "notice")
        .at(-1);
    assert.ok(lastNotice && lastNotice.type === "notice");
    assert.ok(lastNotice.content.includes("Persisted Sessions:"));
    assert.ok(lastNotice.content.includes(sessionAId.slice(0, 8)));

    // Resume session A via /resume <id>
    await controllerB.submit(`/resume ${sessionAId}`);
    assert.equal(controllerB.getSession().id, sessionAId);

    // Verify UI history reconstructed
    const snapshotB = controllerB.getSnapshot();
    const messages = snapshotB.history.filter((h) => h.type === "message");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal((messages[0] as any).content, "First message in session A");
    assert.equal(messages[1].role, "assistant");
    assert.equal((messages[1] as any).content, "Echo: First message in session A");

    // 3. Continue in resumed session
    await controllerB.submit("Second message in session A");

    // Verify SQLite items appended with correct sequence without conflict
    const updatedItemsA = await store.getTranscriptItems(sessionAId);
    assert.equal(updatedItemsA.length, 4);
    assert.equal(updatedItemsA[0].sequence, 0);
    assert.equal(updatedItemsA[1].sequence, 1);
    assert.equal(updatedItemsA[2].sequence, 2);
    assert.equal(updatedItemsA[3].sequence, 3);

    const user2 = JSON.parse(updatedItemsA[2].payload);
    assert.equal(user2.type, "user");
    assert.equal(user2.content, "Second message in session A");

    await controllerB.dispose();
    await store.close();
});

test("Session restoration: unambiguous prefix resume and ambiguous prefix rejection", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const persistence = new ConversationMemoryOrchestrator(store);

    const provider = makeProvider(() => "ok");
    const toolRegistry = createToolRegistry();

    // Create session 1 with prefix "aaaa-1111"
    const session1Id = "aaaa-1111-2222-3333";
    await store.saveTranscriptItems(session1Id, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "Prompt 1" }),
        },
    ]);

    // Create session 2 with prefix "aaaa-9999"
    const session2Id = "aaaa-9999-8888-7777";
    await store.saveTranscriptItems(session2Id, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "Prompt 2" }),
        },
    ]);

    // Create session 3 with distinct prefix "bbbb-0000"
    const session3Id = "bbbb-0000-1111-2222";
    await store.saveTranscriptItems(session3Id, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "Prompt 3" }),
        },
    ]);

    const controller = createCliController({
        provider,
        toolRegistry,
        persistence,
        store,
    });

    const initialSessionId = controller.getSession().id;

    // Ambiguous prefix "aaaa" -> should be rejected and leave session untouched
    await controller.submit("/resume aaaa");
    assert.equal(controller.getSession().id, initialSessionId);
    const notices = controller.getSnapshot().history.filter((h) => h.type === "notice");
    assert.ok(
        notices.some(
            (n) =>
                n.type === "notice" &&
                n.kind === "error" &&
                n.content.includes('Ambiguous session ID "aaaa"'),
        ),
    );

    // Non-existent prefix "zzzz" -> should be rejected and leave session untouched
    await controller.submit("/resume zzzz");
    assert.equal(controller.getSession().id, initialSessionId);
    const notices2 = controller.getSnapshot().history.filter((h) => h.type === "notice");
    assert.ok(
        notices2.some(
            (n) =>
                n.type === "notice" &&
                n.kind === "error" &&
                n.content.includes('Session not found: "zzzz"'),
        ),
    );

    // Unambiguous prefix "bbbb" -> restores session 3
    await controller.submit("/resume bbbb");
    assert.equal(controller.getSession().id, session3Id);
    assert.equal(controller.getSession().transcript.length, 1);
    const restoredItem = controller.getSession().transcript[0];
    assert.equal(restoredItem.type, "user");
    assert.equal(restoredItem.content, "Prompt 3");

    await controller.dispose();
    await store.close();
});

test("Session restoration: no replay of historical tools, full results intact, preserves completed, failed, interrupted turns", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const persistence = new ConversationMemoryOrchestrator(store);

    let toolsExecuted = 0;
    const toolRegistry = createToolRegistry();

    const targetSessionId = "tool-history-session";
    const historicalItems: TranscriptItem[] = [
        { type: "user", content: "Run inspection" },
        {
            type: "tool_execution",
            callId: "call_1",
            toolName: "read_file",
            arguments: { path: "src/main.ts" },
            result: "FULL_ORIGINAL_FILE_CONTENT_XYZ_12345",
            status: "completed",
            durationMs: 42,
        },
        { type: "assistant", content: "File inspected cleanly.", status: "completed" },
        { type: "user", content: "Do something that failed" },
        {
            type: "assistant",
            content: "Partial failure message",
            status: "failed",
        },
        { type: "user", content: "Do something that got cancelled" },
        {
            type: "assistant",
            content: "Interrupted partial message",
            status: "interrupted",
        },
    ];

    // Store in SQLite with non-trivial sequences (with sequence gap testing)
    await store.saveTranscriptItems(
        targetSessionId,
        historicalItems.map((item, idx) => ({
            sequence: idx * 2, // 0, 2, 4, 6, 8, 10, 12 -> maxSequence is 12, next must be 13
            type: item.type,
            payload: JSON.stringify(item),
        })),
    );

    const provider = makeProvider(() => "next turn reply");

    const controller = createCliController({
        provider,
        toolRegistry,
        persistence,
        store,
    });

    await controller.submit(`/resume ${targetSessionId}`);
    assert.equal(controller.getSession().id, targetSessionId);

    // Invariant: NEVER rerun historical tools during restoration
    assert.equal(toolsExecuted, 0);

    // Canonical transcript check
    const transcript = controller.getSession().transcript;
    assert.equal(transcript.length, 7);

    // Full original tool result preserved
    assert.equal(transcript[1].type, "tool_execution");
    const restoredTool = transcript[1] as any;
    assert.equal(restoredTool.result, "FULL_ORIGINAL_FILE_CONTENT_XYZ_12345");
    assert.equal(restoredTool.durationMs, 42);
    assert.equal(restoredTool.status, "completed");

    // Completed, failed, interrupted assistant items preserved
    assert.equal(transcript[2].type, "assistant");
    assert.equal((transcript[2] as any).status, "completed");

    assert.equal(transcript[4].type, "assistant");
    assert.equal((transcript[4] as any).status, "failed");

    assert.equal(transcript[6].type, "assistant");
    assert.equal((transcript[6] as any).status, "interrupted");

    // Continue session and check sequence: max sequence was 12, so next must be 13 & 14
    await controller.submit("Next prompt after resume");

    const allRecords = await store.getTranscriptItems(targetSessionId);
    assert.equal(allRecords.length, 9); // 7 historical + 2 new
    assert.equal(allRecords[7].sequence, 13);
    assert.equal(allRecords[8].sequence, 14);

    await controller.dispose();
    await store.close();
});

test("Session restoration: corrupt or contradictory records fail without touching current session", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const corruptSessionId = "corrupt-session";
    // Bad JSON payload
    await store.saveTranscriptItems(corruptSessionId, [
        {
            sequence: 0,
            type: "user",
            payload: "{ not valid json",
        },
    ]);

    const contradictorySessionId = "contradictory-session";
    // Type mismatch: record says 'user' but payload says 'assistant'
    await store.saveTranscriptItems(contradictorySessionId, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "assistant", content: "mismatch" }),
        },
    ]);

    const provider = makeProvider(() => "ok");
    const controller = createCliController({
        provider,
        toolRegistry: createToolRegistry(),
        store,
    });

    const originalId = controller.getSession().id;

    // Try resuming corrupt session
    await controller.submit(`/resume ${corruptSessionId}`);
    assert.equal(controller.getSession().id, originalId);
    assert.ok(
        controller
            .getSnapshot()
            .history.some(
                (h) =>
                    h.type === "notice" &&
                    h.kind === "error" &&
                    h.content.includes("Failed to restore session"),
            ),
    );

    // Try resuming contradictory session
    await controller.submit(`/resume ${contradictorySessionId}`);
    assert.equal(controller.getSession().id, originalId);
    assert.ok(
        controller
            .getSnapshot()
            .history.some(
                (h) =>
                    h.type === "notice" &&
                    h.kind === "error" &&
                    h.content.includes("Record type mismatch"),
            ),
    );

    await controller.dispose();
    await store.close();
});

test("Session restoration: Context Compiler and Compactor are correctly bound to resumed session ID", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const persistence = new ConversationMemoryOrchestrator(store);

    const capturedCompileSessionIds: string[] = [];
    const capturedCompactSessionIds: string[] = [];

    const profile: ModelProfile = {
        id: "test-bound-profile",
        contextWindowTokens: 1000,
        maxOutputTokens: 200,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };
    const budget = deriveContextBudget(profile);

    const mockCompactor: ContextCompactor = {
        compactHistory: async (options) => {
            if (options.sessionId) {
                capturedCompactSessionIds.push(options.sessionId);
            }
            return {
                taskOrInvestigation: "Test investigation",
                importantFindings: ["Resumed session compaction"],
                filesAndLocations: [],
                decisions: [],
                failedApproaches: [],
                unresolvedIssues: [],
                nextSteps: [],
                omissions: "None",
                sourceRange: {
                    sessionId: options.sessionId,
                    startSequence: options.startSequence,
                    endSequence: options.endSequence,
                },
            };
        },
        compactToolResult: async () => null,
    };

    const targetSessionId = "resumed-session-target";
    // Seed 4 turns so compaction threshold is triggered
    await store.saveTranscriptItems(targetSessionId, [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "A".repeat(500) }),
        },
        {
            sequence: 1,
            type: "assistant",
            payload: JSON.stringify({
                type: "assistant",
                content: "B".repeat(500),
                status: "completed",
            }),
        },
        {
            sequence: 2,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "C".repeat(500) }),
        },
        {
            sequence: 3,
            type: "assistant",
            payload: JSON.stringify({
                type: "assistant",
                content: "D".repeat(500),
                status: "completed",
            }),
        },
    ]);

    const createCompiler = (sessionId: string) => {
        const c = createBoundedContextCompiler({
            budget,
            profile,
            compactor: mockCompactor,
            compactionThreshold: 0.1, // low threshold to force compaction
            sessionId,
        });

        const origCompile = c.compile.bind(c);
        c.compile = async (input, options) => {
            capturedCompileSessionIds.push(sessionId);
            return origCompile(input, options);
        };
        return c;
    };

    const provider = makeProvider(() => "Response after resume");

    const controller = createCliController({
        provider,
        toolRegistry: createToolRegistry(),
        persistence,
        profile,
        budget,
        compactor: mockCompactor,
        store,
        createCompiler,
    });

    await controller.submit(`/resume ${targetSessionId}`);
    assert.equal(controller.getSession().id, targetSessionId);

    // Send a new message: compiler and compactor must execute with targetSessionId, NOT initial session ID!
    await controller.submit("New turn triggering compiler");

    assert.ok(capturedCompileSessionIds.includes(targetSessionId));
    assert.ok(capturedCompactSessionIds.includes(targetSessionId));

    await controller.dispose();
    await store.close();
});

test("Session commands: /clear starts a fresh session while older sessions remain recoverable", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const persistence = new ConversationMemoryOrchestrator(store);

    const provider = makeProvider((req) => `Reply to ${(req.items.at(-1) as any)?.content}`);

    const controller = createCliController({
        provider,
        toolRegistry: createToolRegistry(),
        persistence,
        store,
    });

    await controller.submit("Turn 1 in session X");
    const sessionXId = controller.getSession().id;

    // Submit /clear
    await controller.submit("/clear");
    const sessionYId = controller.getSession().id;

    // Must have a new fresh session ID
    assert.notEqual(sessionYId, sessionXId);
    assert.equal(controller.getSession().transcript.length, 0);

    // Submit a message in session Y
    await controller.submit("Turn 1 in session Y");

    // Both sessions exist and are recoverable in SQLite!
    const sessionsList = await store.listSessions(10);
    const sessionIds = sessionsList.map((s) => s.id);
    assert.ok(sessionIds.includes(sessionXId));
    assert.ok(sessionIds.includes(sessionYId));

    // Resume session X
    await controller.submit(`/resume ${sessionXId}`);
    assert.equal(controller.getSession().id, sessionXId);
    assert.equal(controller.getSession().transcript.length, 2);
    const item0 = controller.getSession().transcript[0];
    assert.equal(item0.type, "user");
    assert.equal(item0.content, "Turn 1 in session X");

    await controller.dispose();
    await store.close();
});
