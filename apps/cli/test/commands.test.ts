import { Session } from "@akkco/core";
import type { ModelEvent, ModelProvider } from "@akkco/models";
import { createRepositoryTools, createToolRegistry, type ToolRegistry } from "@akkco/tools";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import {
    createBuiltinCommandRegistry,
    createCommandRegistry,
    type CliCommand,
    type CommandContext,
} from "../src/commands/command-registry.js";
import { createCliController } from "../src/state/cli-controller.js";
import type { HistoryItemPayload } from "../src/state/types.js";

const createMockProvider = (
    responses: string[] = ["test response"],
    onStream?: () => void,
): ModelProvider => {
    let callCount = 0;

    return {
        id: "mock-provider",
        stream: () => {
            onStream?.();
            const text = responses[callCount++] ?? "fallback";

            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: text } satisfies ModelEvent;
                },
            };
        },
    };
};

const createMockContext = (
    toolRegistry: ToolRegistry,
): CommandContext & {
    notices: { content: string; kind?: "info" | "error" | "warning" }[];
    history: HistoryItemPayload[];
    exited: boolean;
    historyCleared: boolean;
} => {
    const provider = createMockProvider();
    const session = new Session({
        run: () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "mock" };
            },
        }),
    });

    const notices: { content: string; kind?: "info" | "error" | "warning" }[] = [];
    const history: HistoryItemPayload[] = [];
    let exited = false;
    let historyCleared = false;

    return {
        session,
        toolRegistry,
        notices,
        history,

        get exited() {
            return exited;
        },

        get historyCleared() {
            return historyCleared;
        },

        appendHistory: (item) => {
            history.push(item);
        },

        notice: (content, kind) => {
            notices.push({ content, kind });
        },

        exit: () => {
            exited = true;
        },

        clearHistory: () => {
            historyCleared = true;
        },

        startTool: () => {},
        finishTool: () => {},
    };
};

test("normal input is not treated as a command", async () => {
    const registry = createBuiltinCommandRegistry();
    const toolRegistry = createToolRegistry(createRepositoryTools(process.cwd()));
    const context = createMockContext(toolRegistry);

    const inputs = ["hello", "hello /clear", "just a normal prompt", "  not a slash command  "];

    for (const input of inputs) {
        const handled = await registry.dispatch(input, context);
        assert.strictEqual(handled, false);
    }

    assert.strictEqual(context.notices.length, 0);
    assert.strictEqual(context.history.length, 0);
});

test("/exit dispatches correctly", async () => {
    const registry = createBuiltinCommandRegistry();
    const toolRegistry = createToolRegistry(createRepositoryTools(process.cwd()));
    const context = createMockContext(toolRegistry);

    const handled = await registry.dispatch("/exit", context);

    assert.strictEqual(handled, true);
    assert.strictEqual(context.exited, true);

    // Also test end-to-end via cli-controller
    const controller = createCliController({
        provider: createMockProvider(),
        toolRegistry,
        commandRegistry: registry,
    });

    assert.strictEqual(controller.getSnapshot().exited, false);
    await controller.submit("/exit");
    assert.strictEqual(controller.getSnapshot().exited, true);
    assert.strictEqual(
        controller
            .getSnapshot()
            .history.some((h) => h.type === "notice" && h.content === "Goodbye."),
        true,
    );
});

test("/clear dispatches correctly", async () => {
    const registry = createBuiltinCommandRegistry();
    const toolRegistry = createToolRegistry(createRepositoryTools(process.cwd()));
    const context = createMockContext(toolRegistry);

    const handled = await registry.dispatch("/clear", context);

    assert.strictEqual(handled, true);
    assert.strictEqual(context.historyCleared, true);
    assert.strictEqual(
        context.notices.some((n) => n.content === "Conversation cleared."),
        true,
    );
});

test("/tools dispatches correctly", async () => {
    const registry = createBuiltinCommandRegistry();
    const toolRegistry = createToolRegistry(createRepositoryTools(process.cwd()));
    const context = createMockContext(toolRegistry);

    const handled = await registry.dispatch("/tools", context);

    assert.strictEqual(handled, true);
    assert.strictEqual(context.history.length, 1);

    const item = context.history[0];
    assert.strictEqual(item?.type, "tools");

    if (item?.type === "tools") {
        const names = item.tools.map((t) => t.name);
        assert.ok(names.includes("read_file"));
        assert.ok(names.includes("list_files"));
        assert.ok(names.includes("search_text"));
    }
});

test("/tool parses command name and raw arguments correctly", async () => {
    const registry = createBuiltinCommandRegistry();
    const toolRegistry = createToolRegistry();

    let executedWith: { name: string; input: unknown } | undefined;
    toolRegistry.register({
        name: "mock_reader",
        description: "Mock tool for tests",
        inputSchema: z.unknown(),
        execute: async (input) => {
            executedWith = { name: "mock_reader", input };
            return { content: "mock contents" };
        },
    });

    const context = createMockContext(toolRegistry);
    let finishedTool: unknown;
    context.finishTool = (execution) => {
        finishedTool = execution;
    };

    const handled = await registry.dispatch(
        '/tool mock_reader {"path": "src/index.ts", "count": 42}',
        context,
    );

    assert.strictEqual(handled, true);
    assert.deepStrictEqual(executedWith, {
        name: "mock_reader",
        input: { path: "src/index.ts", count: 42 },
    });

    assert.ok(finishedTool);
    assert.strictEqual((finishedTool as { status: string }).status, "completed");
});

test("/tool with no args preserves current usage error", async () => {
    const registry = createBuiltinCommandRegistry();
    const toolRegistry = createToolRegistry();
    const context = createMockContext(toolRegistry);

    for (const emptyInput of ["/tool", "/tool   ", "  /tool  "]) {
        const handled = await registry.dispatch(emptyInput, context);
        assert.strictEqual(handled, true);
    }

    assert.strictEqual(context.notices.length, 3);
    for (const notice of context.notices) {
        assert.strictEqual(notice.content, "Usage: /tool <name> [json]");
        assert.strictEqual(notice.kind, "error");
    }
});

test("/tool invalid JSON preserves current error", async () => {
    const registry = createBuiltinCommandRegistry();
    const toolRegistry = createToolRegistry();
    const context = createMockContext(toolRegistry);

    const handled = await registry.dispatch("/tool read_file {invalid-json-body", context);

    assert.strictEqual(handled, true);
    assert.strictEqual(context.notices.length, 1);
    assert.strictEqual(context.notices[0]?.content, "Error: Invalid JSON input for tool.");
    assert.strictEqual(context.notices[0]?.kind, "error");
});

test("unknown slash command returns a useful error and is NOT sent to Session", async () => {
    let streamCalled = false;
    const provider = createMockProvider(["should not receive this"], () => {
        streamCalled = true;
    });

    const toolRegistry = createToolRegistry(createRepositoryTools(process.cwd()));
    const controller = createCliController({
        provider,
        toolRegistry,
    });

    await controller.submit("/banana");

    assert.strictEqual(
        streamCalled,
        false,
        "Provider stream must not be invoked for slash commands",
    );

    const snapshot = controller.getSnapshot();
    assert.strictEqual(snapshot.status, "idle");
    assert.strictEqual(snapshot.outcome, "error");

    const noticeItem = snapshot.history.find(
        (h) => h.type === "notice" && h.content === "Unknown command: /banana",
    );
    assert.ok(noticeItem, "Expected Unknown command: /banana notice in history");
});

test("command registry rejects duplicate command names if registration is dynamic", () => {
    const registry = createCommandRegistry();

    const dummyCommand: CliCommand = {
        name: "test_cmd",
        description: "Test command",
        execute: () => {},
    };

    registry.register(dummyCommand);

    assert.throws(() => registry.register(dummyCommand), /Command already registered: \/test_cmd/);

    assert.throws(
        () =>
            registry.register({
                name: "/TEST_CMD",
                description: "Duplicate with uppercase and slash",
                execute: () => {},
            }),
        /Command already registered: \/test_cmd/,
    );

    assert.throws(
        () =>
            registry.register({
                name: "",
                description: "Empty name",
                execute: () => {},
            }),
        /Command name cannot be empty/,
    );
});

test("controller queues submissions while async command execution is running", async () => {
    const toolRegistry = createToolRegistry();
    let releaseToolExecution = () => {};

    const toolWait = new Promise<void>((resolve) => {
        releaseToolExecution = resolve;
    });

    toolRegistry.register({
        name: "slow_tool",
        description: "Slow tool to test locking",
        inputSchema: z.unknown(),
        execute: async () => {
            await toolWait;
            return { content: "slow done" };
        },
    });

    const controller = createCliController({
        provider: createMockProvider(),
        toolRegistry,
    });

    // Start async tool execution
    const firstSubmission = controller.submit("/tool slow_tool {}");

    // Controller should be locked
    assert.notStrictEqual(controller.getSnapshot().status, "idle");

    // Second submission waits for the tool rather than running concurrently.
    const secondSubmission = controller.submit("second prompt while busy");
    await secondSubmission;

    assert.deepEqual(controller.getSnapshot().queuedPrompts, ["second prompt while busy"]);
    assert.ok(!controller.getSnapshot().history.some((item) => item.type === "message"));

    // Release first command
    releaseToolExecution();
    await firstSubmission;

    // Controller returns to idle
    assert.strictEqual(controller.getSnapshot().status, "idle");

    const messages = controller.getSnapshot().history.filter((h) => h.type === "message");
    assert.deepEqual(
        messages.map((item) => item.content),
        ["second prompt while busy", "test response"],
    );
    assert.deepEqual(controller.getSnapshot().queuedPrompts, []);
});

test("existing /clear Session semantics remain intact", async () => {
    const provider = createMockProvider(["turn 1 response", "turn 2 response"]);
    const toolRegistry = createToolRegistry(createRepositoryTools(process.cwd()));
    const controller = createCliController({ provider, toolRegistry });

    // Run a turn so history and session transcript have content
    await controller.submit("turn 1");

    assert.ok(controller.getSnapshot().history.length >= 2);
    const initialVersion = controller.getSnapshot().historyVersion;

    await controller.submit("/clear");

    const snapshot = controller.getSnapshot();
    assert.strictEqual(snapshot.historyVersion, initialVersion + 1);
    assert.strictEqual(snapshot.history.length, 1);
    assert.strictEqual(snapshot.history[0]?.type, "notice");

    if (snapshot.history[0]?.type === "notice") {
        assert.strictEqual(snapshot.history[0].content, "Conversation cleared.");
    }
});

test("existing manual tool result/error rendering semantics remain intact", async () => {
    const toolRegistry = createToolRegistry();

    toolRegistry.register({
        name: "succeeding_tool",
        description: "Always succeeds",
        inputSchema: z.unknown(),
        execute: async () => ({ content: "manual tool output data" }),
    });

    toolRegistry.register({
        name: "failing_tool",
        description: "Always fails",
        inputSchema: z.unknown(),
        execute: async () => {
            throw new Error("Deliberate failure in tool");
        },
    });

    const controller = createCliController({
        provider: createMockProvider(),
        toolRegistry,
    });

    // 1. Success case
    await controller.submit('/tool succeeding_tool {"sample": 123}');

    const successItem = controller.getSnapshot().history.find((h) => h.type === "tool");
    assert.ok(successItem && successItem.type === "tool");
    assert.strictEqual(successItem.execution.status, "completed");
    assert.strictEqual(successItem.execution.showResult, true);
    assert.strictEqual(successItem.execution.result, "manual tool output data");
    assert.strictEqual(typeof successItem.execution.durationMs, "number");

    // 2. Failure case
    await controller.submit("/tool failing_tool {}");

    assert.strictEqual(controller.getSnapshot().outcome, "error");
    const failedItem = controller
        .getSnapshot()
        .history.filter((h) => h.type === "tool")
        .at(-1);

    assert.ok(failedItem && failedItem.type === "tool");
    assert.strictEqual(failedItem.execution.status, "failed");
    assert.strictEqual(failedItem.execution.error, "Deliberate failure in tool");
    assert.strictEqual(typeof failedItem.execution.durationMs, "number");
});

test("F-001: /clear starts a fresh logical session preserving previous session records in SQLite", async () => {
    const { SqliteConversationStore } = await import("@akkco/retrieval");
    const { ConversationMemoryOrchestrator } = await import("@akkco/core");

    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const persistence = new ConversationMemoryOrchestrator(store);

    const provider = createMockProvider(["answer 1", "answer 2", "answer 3"]);
    const toolRegistry = createToolRegistry();
    const controller = createCliController({
        provider,
        toolRegistry,
        persistence,
    });

    const session1Id = controller.getSession().id;

    // Turn 1 and Turn 2 in session 1
    await controller.submit("turn 1 question");
    await controller.submit("turn 2 question");

    const session1Items = await store.getTranscriptItems(session1Id);
    assert.strictEqual(session1Items.length, 4);

    // Clear session
    await controller.submit("/clear");

    const session2Id = controller.getSession().id;
    assert.notStrictEqual(session1Id, session2Id);

    // Turn 3 in new session 2
    await controller.submit("turn 3 question in fresh session");

    // Session 2 should have its own items starting from sequence 0
    const session2Items = await store.getTranscriptItems(session2Id);
    assert.strictEqual(session2Items.length, 2);
    assert.strictEqual(session2Items[0].sequence, 0);
    assert.strictEqual(session2Items[1].sequence, 1);

    // Session 1 items in SQLite remain intact and untouched!
    const session1ItemsAfter = await store.getTranscriptItems(session1Id);
    assert.strictEqual(session1ItemsAfter.length, 4);

    await store.close();
});

test("formatUnambiguousSessionId generates distinct, unambiguous identifiers suitable for /resume", async () => {
    const { formatUnambiguousSessionId } = await import("../src/commands/session-commands.js");

    const uuid1 = "4cc498fe-ece0-4a3e-a202-d365be07947a";
    const uuid2 = "d8ab64b7-03c8-4247-9b02-d8f4ff8876d2";
    const uuidCollision1 = "12345678-aaaa-bbbb-cccc-111111111111";
    const uuidCollision2 = "12345678-bbbb-cccc-dddd-222222222222";

    const testSession1 = "session-1791542889779";
    const testSession2 = "session-1791542888585";
    const shortNamed = "auth-refactor";

    const allIds = [
        uuid1,
        uuid2,
        uuidCollision1,
        uuidCollision2,
        testSession1,
        testSession2,
        shortNamed,
    ];

    // Standard UUIDs without collision produce 8-character prefix
    assert.strictEqual(formatUnambiguousSessionId(uuid1, allIds), "4cc498fe");
    assert.strictEqual(formatUnambiguousSessionId(uuid2, allIds), "d8ab64b7");

    // Colliding UUIDs expand prefix to resolve ambiguity
    const formattedCol1 = formatUnambiguousSessionId(uuidCollision1, allIds);
    const formattedCol2 = formatUnambiguousSessionId(uuidCollision2, allIds);
    assert.notStrictEqual(formattedCol1, formattedCol2);
    assert.ok(formattedCol1.length > 8);
    assert.ok(formattedCol2.length > 8);
    assert.ok(uuidCollision1.startsWith(formattedCol1));
    assert.ok(uuidCollision2.startsWith(formattedCol2));

    // Sessions starting with session- MUST NOT be trimmed to identical "session-"
    const formattedTest1 = formatUnambiguousSessionId(testSession1, allIds);
    const formattedTest2 = formatUnambiguousSessionId(testSession2, allIds);
    assert.notStrictEqual(formattedTest1, "session-");
    assert.notStrictEqual(formattedTest2, "session-");
    assert.notStrictEqual(formattedTest1, formattedTest2);
    assert.strictEqual(formattedTest1, testSession1);
    assert.strictEqual(formattedTest2, testSession2);

    // Short custom named sessions are preserved completely
    assert.strictEqual(formatUnambiguousSessionId(shortNamed, allIds), "auth-refactor");
});

test("/sessions lists sessions newest-first, avoids ambiguous identical prefixes, and supports pagination", async () => {
    const { SqliteConversationStore } = await import("@akkco/retrieval");
    const { ConversationMemoryOrchestrator } = await import("@akkco/core");

    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const persistence = new ConversationMemoryOrchestrator(store);

    const provider = createMockProvider();
    const toolRegistry = createToolRegistry();
    const controller = createCliController({
        provider,
        toolRegistry,
        persistence,
        store,
    });

    // Seed 25 sessions into SQLite
    for (let i = 1; i <= 25; i++) {
        const id =
            i % 2 === 0
                ? `session-17915428800${i.toString().padStart(2, "0")}`
                : `00000000-0000-0000-0000-${i.toString().padStart(12, "0")}`;
        const timestamp = new Date(1791542880000 + i * 1000).toISOString();
        await store.saveSession({ id, createdAt: timestamp, updatedAt: timestamp });
        await store.saveTranscriptItems(id, [
            {
                sequence: 0,
                type: "user",
                payload: JSON.stringify({ type: "user", content: `Prompt for session ${i}` }),
                createdAt: timestamp,
            },
        ]);
    }

    // 1. Default /sessions (limit 20, offset 0)
    await controller.submit("/sessions");
    const history1 = controller.getSnapshot().history;
    const notices1 = history1.filter((h) => h.type === "notice");
    assert.ok(notices1.length >= 1);
    const output1 = notices1[notices1.length - 1].content;

    assert.match(output1, /Persisted Sessions: \(showing 1–20 of 25, newest first\)/);
    assert.doesNotMatch(output1, /  session- ·/); // Must never show identical "session-" prefix
    assert.match(output1, /Use "\/sessions 20 20" or "\/sessions page 2" to view older sessions\./);

    // 2. Paginated /sessions page 2
    await controller.submit("/sessions page 2");
    const history2 = controller.getSnapshot().history;
    const lastItem2 = history2[history2.length - 1];
    assert.strictEqual(lastItem2.type, "notice");
    const output2 = lastItem2.content;
    assert.match(output2, /Persisted Sessions: \(showing 21–25 of 25, newest first\)/);

    // 3. /sessions prune / clean guidance notice
    await controller.submit("/sessions prune");
    const history3 = controller.getSnapshot().history;
    const lastItem3 = history3[history3.length - 1];
    assert.strictEqual(lastItem3.type, "notice");
    const outputPrune = lastItem3.content;
    assert.match(outputPrune, /npm run clean:test-sessions/);

    await store.close();
});

test("clean-test-sessions script: performs dry-run and apply with backup cleanly", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const { SqliteConversationStore } = await import("@akkco/retrieval");
    const { runCleanTestSessionsScript } = await import("../src/scripts/clean-test-sessions.js");

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "script-clean-test-"));
    const testDbPath = path.join(tempDir, "script-test.db");

    const store = new SqliteConversationStore({ dbPath: testDbPath });
    await store.initialize();
    await store.saveSession({ id: "user-real-session-123" });
    await store.saveSession({ id: "session-1791542880999" });
    await store.saveTranscriptItems("session-1791542880999", [
        {
            sequence: 0,
            type: "user",
            payload: JSON.stringify({ type: "user", content: "__TEST_WAIT__" }),
        },
    ]);
    await store.close();

    try {
        // 1. Dry run via script
        const exitDry = await runCleanTestSessionsScript(["--dry-run", "--db", testDbPath]);
        assert.strictEqual(exitDry, 0);

        // Verify records still exist after dry run
        const storeAfterDry = new SqliteConversationStore({ dbPath: testDbPath });
        await storeAfterDry.initialize();
        assert.strictEqual(await storeAfterDry.countSessions(), 2);
        await storeAfterDry.close();

        // 2. Apply via script with confirmation
        const exitApply = await runCleanTestSessionsScript([
            "--apply",
            "--confirm",
            "--db",
            testDbPath,
        ]);
        assert.strictEqual(exitApply, 0);

        // Verify only user session remains
        const storeAfterApply = new SqliteConversationStore({ dbPath: testDbPath });
        await storeAfterApply.initialize();
        const remaining = await storeAfterApply.listSessions();
        assert.strictEqual(remaining.length, 1);
        assert.strictEqual(remaining[0].id, "user-real-session-123");
        await storeAfterApply.close();
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
