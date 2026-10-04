import { Session } from "@akkco/core";
import type { ModelEvent, ModelProvider } from "@akkco/models";
import { createRepositoryTools, createToolRegistry, type ToolRegistry } from "@akkco/tools";
import assert from "node:assert/strict";
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
