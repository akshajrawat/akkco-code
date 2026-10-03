import type { ModelEvent, ModelProvider } from "@akkco/models";
import { createRepositoryTools, createToolRegistry } from "@akkco/tools";
import { render } from "ink";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createElement } from "react";
import stringWidth from "string-width";
import { App } from "../src/app.js";
import {
    createBuiltinCommandRegistry,
    createCommandRegistry,
    type CliCommand,
} from "../src/commands/command-registry.js";
import { CommandSuggestions } from "../src/components/CommandSuggestions.js";
import { createCliController } from "../src/state/cli-controller.js";
import type { CliMetadata } from "../src/state/types.js";
import {
    applyCompletion,
    calculateSuggestionsHeight,
    commandExpectsArguments,
    filterCommands,
    getCommandPrefix,
    getNextSelection,
} from "../src/ui/command-suggestions.js";
import { createTerminalInput, type TerminalInputEvent } from "../src/ui/terminal-input.js";
import { enterTerminal } from "../src/ui/terminal.js";

const metadata: CliMetadata = {
    version: "0.0.1",
    provider: "OpenAICompatible",
    model: "test-model",
    toolMode: "native",
    cwd: "/repo",
};

const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;

    while (!predicate()) {
        assert.ok(Date.now() < deadline, "Timed out waiting for terminal output");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

const createMockProvider = (): ModelProvider => ({
    id: "test",
    stream: () => ({
        [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<ModelEvent>> => ({
                done: true,
                value: undefined,
            }),
        }),
    }),
});

const mount = (columns = 80, rows = 24, commandRegistry = createBuiltinCommandRegistry()) => {
    const toolRegistry = createToolRegistry(createRepositoryTools(process.cwd()));
    const controller = createCliController({
        provider: createMockProvider(),
        toolRegistry,
        commandRegistry,
    });

    const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: () => {},
        ref: () => {},
        unref: () => {},
    });

    const output = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
    let frame = "";

    output.on("data", (data) => {
        const clean = stripVTControlCharacters(data.toString());
        if (clean.includes("› ") || clean.includes("Commands")) {
            frame = clean;
        }
    });

    const instance = render(createElement(App, { controller, metadata }), {
        stdin: input as unknown as typeof process.stdin,
        stdout: output as unknown as typeof process.stdout,
        stderr: output as unknown as typeof process.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
    });

    return {
        controller,
        input,
        output,
        instance,
        frame: () => frame,
        cleanup: () => {
            instance.unmount();
            controller.dispose();
            input.destroy();
            output.destroy();
        },
    };
};

test("1. typing '/' returns all registered commands", () => {
    const registry = createBuiltinCommandRegistry();
    const commands = registry.list();

    const prefix = getCommandPrefix("/", 1);
    assert.strictEqual(prefix, "");

    const filtered = filterCommands(commands, prefix!);
    assert.strictEqual(filtered.length, 4);

    const names = filtered.map((c) => c.name);
    assert.deepStrictEqual(names, ["clear", "exit", "tool", "tools"]);
});

test("2. '/t' filters correctly", () => {
    const registry = createBuiltinCommandRegistry();
    const commands = registry.list();

    const prefix = getCommandPrefix("/t", 2);
    assert.strictEqual(prefix, "t");

    const filtered = filterCommands(commands, prefix!);
    assert.strictEqual(filtered.length, 2);
    assert.deepStrictEqual(
        filtered.map((c) => c.name),
        ["tool", "tools"],
    );
});

test("3. '/to' returns /tool and /tools", () => {
    const registry = createBuiltinCommandRegistry();
    const commands = registry.list();

    const prefix = getCommandPrefix("/to", 3);
    assert.strictEqual(prefix, "to");

    const filtered = filterCommands(commands, prefix!);
    assert.strictEqual(filtered.length, 2);
    assert.deepStrictEqual(
        filtered.map((c) => c.name),
        ["tool", "tools"],
    );
});

test("4. normal text does not open suggestions", () => {
    assert.strictEqual(getCommandPrefix("hello", 5), null);
    assert.strictEqual(getCommandPrefix("read_file", 9), null);
    assert.strictEqual(getCommandPrefix("", 0), null);
    assert.strictEqual(getCommandPrefix("   some text", 12), null);
});

test("5. 'hello /' does not open suggestions", () => {
    assert.strictEqual(getCommandPrefix("hello /", 7), null);
    assert.strictEqual(getCommandPrefix("echo /to", 8), null);
});

test("6. '/tool ' hides command-name suggestions", () => {
    assert.strictEqual(getCommandPrefix("/tool ", 6), null);
    assert.strictEqual(getCommandPrefix("/tool read_file", 15), null);
    assert.strictEqual(getCommandPrefix("/clear ", 7), null);
});

test("7. ArrowDown and 8. ArrowUp change selected command with wrapping", () => {
    const total = 4;

    // Down navigation wraps: 0 -> 1 -> 2 -> 3 -> 0
    let index = 0;
    index = getNextSelection(index, total, "down");
    assert.strictEqual(index, 1);
    index = getNextSelection(index, total, "down");
    assert.strictEqual(index, 2);
    index = getNextSelection(index, total, "down");
    assert.strictEqual(index, 3);
    index = getNextSelection(index, total, "down");
    assert.strictEqual(index, 0);

    // Up navigation wraps: 0 -> 3 -> 2 -> 1 -> 0
    index = getNextSelection(index, total, "up");
    assert.strictEqual(index, 3);
    index = getNextSelection(index, total, "up");
    assert.strictEqual(index, 2);
    index = getNextSelection(index, total, "up");
    assert.strictEqual(index, 1);
    index = getNextSelection(index, total, "up");
    assert.strictEqual(index, 0);
});

test("9. Tab completes selected command with trailing space when arguments expected", () => {
    const registry = createBuiltinCommandRegistry();
    const commands = registry.list();

    const toolCmd = commands.find((c) => c.name === "tool")!;
    assert.ok(toolCmd);
    assert.strictEqual(commandExpectsArguments(toolCmd), true);

    const completionWithArgs = applyCompletion("/to", 3, toolCmd);
    assert.strictEqual(completionWithArgs.text, "/tool ");
    assert.strictEqual(completionWithArgs.cursor, 6);

    const clearCmd = commands.find((c) => c.name === "clear")!;
    assert.ok(clearCmd);
    assert.strictEqual(commandExpectsArguments(clearCmd), false);

    const completionNoArgs = applyCompletion("/cl", 3, clearCmd);
    assert.strictEqual(completionNoArgs.text, "/clear");
    assert.strictEqual(completionNoArgs.cursor, 6);
});

test("10. Tab does not execute command", () => {
    // applyCompletion is a pure transformation; verify it only produces modified text/cursor
    const res = applyCompletion("/to", 3, {
        name: "tool",
        description: "Manually execute tool",
        usage: "/tool <name> [json]",
    });
    assert.strictEqual(res.text, "/tool ");
    assert.strictEqual(typeof res.cursor, "number");
});

test("11. Enter still submits through CliController/CommandRegistry", async () => {
    const terminal = mount(80, 24);

    try {
        await waitFor(() => terminal.frame().includes("Idle"));

        // Type /clear and press enter
        terminal.input.write("/clear");
        await waitFor(() => terminal.frame().includes("› /clear"));

        terminal.input.write("\r");
        await waitFor(() => terminal.frame().includes("Conversation cleared."));

        const snapshot = terminal.controller.getSnapshot();
        assert.ok(
            snapshot.history.some(
                (h) => h.type === "notice" && h.content === "Conversation cleared.",
            ),
        );
    } finally {
        terminal.cleanup();
    }
});

test("12. Escape closes suggestions and typing allows them to reappear", async () => {
    const terminal = mount(80, 24);

    try {
        await waitFor(() => terminal.frame().includes("Idle"));

        // Type "/" -> suggestions panel opens
        terminal.input.write("/");
        await waitFor(() => terminal.frame().includes("┌ Commands"));
        assert.ok(terminal.frame().includes("/clear"));

        // Press Escape (using 0 timeout or direct \x1b)
        terminal.input.write("\x1b");
        await waitFor(() => !terminal.frame().includes("┌ Commands"));

        // Type "t" -> suggestions reappear
        terminal.input.write("t");
        await waitFor(() => terminal.frame().includes("┌ Commands"));
        assert.ok(terminal.frame().includes("/tool"));
        assert.ok(terminal.frame().includes("/tools"));
        assert.ok(!terminal.frame().includes("/clear"));
    } finally {
        terminal.cleanup();
    }
});

test("13. future dynamically registered command automatically appears", () => {
    const registry = createCommandRegistry();

    const futureCmd: CliCommand = {
        name: "resume",
        description: "Resume an existing session",
        usage: "/resume [session_id]",
        execute: () => {},
    };

    registry.register(futureCmd);

    const commands = registry.list();
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0]?.name, "resume");
    assert.strictEqual(commands[0]?.description, "Resume an existing session");

    const filtered = filterCommands(commands, "res");
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0]?.name, "resume");
});

test("14. palette height is bounded", () => {
    assert.strictEqual(calculateSuggestionsHeight(0, 5), 0);
    assert.strictEqual(calculateSuggestionsHeight(1, 5), 3); // 1 top + 1 item + 1 bottom
    assert.strictEqual(calculateSuggestionsHeight(4, 5), 6); // 1 top + 4 items + 1 bottom
    assert.strictEqual(calculateSuggestionsHeight(5, 5), 7); // 1 top + 5 items + 1 bottom
    assert.strictEqual(calculateSuggestionsHeight(10, 5), 7); // bounded at maxVisible=5 (7 rows)
});

test("15. narrow terminal rendering does not overflow", () => {
    const registry = createBuiltinCommandRegistry();
    const commands = registry.list();

    for (const width of [20, 30, 45, 80, 120]) {
        const element = createElement(CommandSuggestions, {
            commands,
            selectedIndex: 0,
            width,
            maxVisible: 5,
        });

        const output = Object.assign(new PassThrough(), { isTTY: true, columns: width, rows: 24 });
        let printed = "";
        output.on("data", (data) => {
            printed += data.toString();
        });

        const instance = render(element, {
            stdout: output as unknown as typeof process.stdout,
            debug: true,
        });

        try {
            const cleanLines = stripVTControlCharacters(printed).split("\n");
            for (const line of cleanLines) {
                if (line) {
                    assert.ok(
                        stringWidth(line) <= width,
                        `Line "${line}" width ${stringWidth(line)} exceeded ${width}`,
                    );
                }
            }
        } finally {
            instance.unmount();
            output.destroy();
        }
    }
});

test("16. terminal input parser decodes tab and escape", () => {
    const events: TerminalInputEvent[] = [];
    const input = createTerminalInput((e) => events.push(e), 0);

    input("\t");
    input("\x1b[Z");
    input("\x1b");

    assert.deepStrictEqual(events, [
        { type: "key", key: "tab" },
        { type: "key", key: "tab" },
        { type: "key", key: "escape" },
    ]);
});

test("17. interactive Tab completes command and hides suggestions", async () => {
    const terminal = mount(80, 24);

    try {
        await waitFor(() => terminal.frame().includes("Idle"));

        // Type "/to"
        terminal.input.write("/to");
        await waitFor(() => terminal.frame().includes("┌ Commands"));
        assert.ok(terminal.frame().includes("/tool"));

        // Press Tab to complete "/tool "
        terminal.input.write("\t");
        await waitFor(() => terminal.frame().includes("› /tool"));

        // Suggestions should be closed because of trailing space
        assert.ok(!terminal.frame().includes("┌ Commands"));
    } finally {
        terminal.cleanup();
    }
});

test("18. interactive Arrow navigation moves selection highlight", async () => {
    const terminal = mount(80, 24);

    try {
        await waitFor(() => terminal.frame().includes("Idle"));

        terminal.input.write("/to");
        await waitFor(() => terminal.frame().includes("┌ Commands"));

        // Default selected is /tool (first)
        // Press Down arrow
        terminal.input.write("\x1b[B");
        await waitFor(() => terminal.frame().includes("┌ Commands"));

        // Press Tab: should complete /tools (since /tools takes no args, completes to /tools)
        terminal.input.write("\t");
        await waitFor(() => terminal.frame().includes("› /tools"));
    } finally {
        terminal.cleanup();
    }
});

test("19. typing '/', navigating with ArrowDown and pressing Enter executes the selected command without 'unknown command' error", async () => {
    const terminal = mount(80, 24);

    try {
        await waitFor(() => terminal.frame().includes("Idle"));

        // Type "/"
        terminal.input.write("/");
        await waitFor(() => terminal.frame().includes("┌ Commands"));

        // Press Down arrow to navigate to /exit
        terminal.input.write("\x1b[B");
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Press Enter
        terminal.input.write("\r");
        await waitFor(() => terminal.controller.getSnapshot().exited === true);

        // Verify it exited cleanly and did NOT emit "Unknown command: /"
        assert.strictEqual(terminal.controller.getSnapshot().exited, true);
        assert.ok(
            !terminal.controller
                .getSnapshot()
                .history.some((h) => h.type === "notice" && h.content.includes("Unknown command")),
        );
    } finally {
        terminal.cleanup();
    }
});

test("20. typing '/', navigating to a command expecting arguments and pressing Enter completes the prompt draft", async () => {
    const terminal = mount(80, 24);

    try {
        await waitFor(() => terminal.frame().includes("Idle"));

        // Type "/"
        terminal.input.write("/");
        await waitFor(() => terminal.frame().includes("┌ Commands"));

        // Navigate Down twice to reach /tool (which expects arguments)
        // Order: clear (0), exit (1), tool (2), tools (3)
        terminal.input.write("\x1b[B");
        terminal.input.write("\x1b[B");
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Press Enter
        terminal.input.write("\r");

        // Should complete to › /tool and close suggestions without an error notice
        await waitFor(() => terminal.frame().includes("› /tool"));
        assert.ok(!terminal.frame().includes("┌ Commands"));
        assert.ok(
            !terminal.controller
                .getSnapshot()
                .history.some((h) => h.type === "notice" && h.content.includes("Unknown command")),
        );
    } finally {
        terminal.cleanup();
    }
});

test("21. Ctrl+A triggers copy of response to clipboard with notice", async () => {
    const terminal = mount(80, 24);

    try {
        await waitFor(() => terminal.frame().includes("Idle"));

        terminal.input.write("\x01");
        await waitFor(() =>
            terminal.controller
                .getSnapshot()
                .history.some(
                    (h) =>
                        h.type === "notice" &&
                        (h.content.includes("Copied") || h.content.includes("No response")),
                ),
        );
    } finally {
        terminal.cleanup();
    }
});

test("22. enterTerminal does not emit mouse tracking codes ?1000h or ?1002h, preserving native mouse selection", () => {
    const input = Object.assign(new PassThrough(), {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
    });
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => {
        written += chunk.toString();
    });

    const restore = enterTerminal(
        input as unknown as typeof process.stdin,
        output as unknown as typeof process.stdout,
    );

    // Must NOT contain mouse click tracking (?1000h) or mouse drag tracking (?1002h) or SGR mode (?1006h)
    assert.ok(!written.includes("\x1b[?1000h"), "Must not enable mouse click tracking");
    assert.ok(!written.includes("\x1b[?1002h"), "Must not enable mouse drag tracking");
    assert.ok(!written.includes("\x1b[?1006h"), "Must not enable SGR mouse tracking");

    // Must still contain alternate screen and bracketed paste
    assert.ok(written.includes("\x1b[?1049h"));
    assert.ok(written.includes("\x1b[?2004h"));

    restore();
    input.destroy();
    output.destroy();
});
