import type { ModelEvent, ModelProvider } from "@akkco/models";
import { createRepositoryTools, createToolRegistry } from "@akkco/tools";
import { render } from "ink";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createElement } from "react";
import { App } from "../src/app.js";
import { createCliController } from "../src/state/cli-controller.js";
import {
    buildConversationLines,
    calculateLayout,
    fitLine,
    promptViewport,
    uiStatus,
    visibleConversation,
} from "../src/ui/layout.js";
import { createTerminalInput, type TerminalInputEvent } from "../src/ui/terminal-input.js";
import { enterTerminal } from "../src/ui/terminal.js";
import type { CliMetadata } from "../src/state/types.js";

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

const createProvider = (events: ModelEvent[], pause = Promise.resolve()): ModelProvider => ({
    id: "test",
    stream: () => {
        let index = 0;

        return {
            [Symbol.asyncIterator]: () => ({
                next: async (): Promise<IteratorResult<ModelEvent>> => {
                    if (index < events.length) {
                        return { done: false, value: events[index++] };
                    }

                    await pause;
                    return { done: true, value: undefined };
                },
            }),
        };
    },
});

const mount = (columns: number, rows: number, provider = createProvider([])) => {
    const toolRegistry = createToolRegistry(createRepositoryTools(process.cwd()));
    const controller = createCliController({ provider, toolRegistry });
    const rawModes: boolean[] = [];

    const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: (enabled: boolean) => {
            rawModes.push(enabled);
        },
        ref: () => {},
        unref: () => {},
    });

    const output = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
    let printed = "";
    let frame = "";

    output.on("data", (data) => {
        printed += data.toString();
        const clean = stripVTControlCharacters(data.toString());

        if (clean.includes("› ") || clean.includes("Akkco Code") || clean.includes("AKKCO CODE")) {
            frame = clean;
        }
    });

    const instance = render(createElement(App, { controller, metadata }), {
        stdin: input as unknown as typeof process.stdin,
        stdout: output as unknown as typeof process.stdout,
        stderr: output as unknown as typeof process.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        // Ink otherwise suppresses interactive repainting when CI is set.
        debug: true,
    });

    return {
        controller,
        toolRegistry,
        input,
        output,
        rawModes,
        instance,
        printed: () => stripVTControlCharacters(printed),
        rawOutput: () => printed,
        frame: () => frame,
        cleanup: () => {
            instance.unmount();
            controller.dispose();
            input.destroy();
            output.destroy();
        },
    };
};

test("responsive layout always reserves space for the footer and bounds the conversation", () => {
    for (const columns of [1, 20, 47, 52, 80, 160]) {
        for (const rows of [2, 4, 8, 12, 24, 50]) {
            const layout = calculateLayout(columns, rows);

            assert.equal(layout.width, columns);
            assert.equal(
                layout.headerHeight + layout.conversationHeight + layout.footerHeight,
                layout.height,
            );
            assert.equal(layout.height, rows - 1);
            assert.ok(layout.conversationHeight >= 0);
            assert.ok(layout.footerHeight >= 1);
        }
    }

    assert.equal(calculateLayout(80, 24).blockLogo, true);
    assert.equal(calculateLayout(47, 24).blockLogo, false);
    assert.equal(calculateLayout(80, 12).blockLogo, false);
    assert.equal(fitLine("abcdef", 4), "abc…");
});

for (const [columns, rows, block] of [
    [80, 24, true],
    [52, 24, true],
    [47, 24, false],
    [80, 12, false],
] as const) {
    test(`header and footer fit within ${columns}×${rows}`, async () => {
        const terminal = mount(columns, rows);

        try {
            await waitFor(() => terminal.frame().includes("Idle"));

            const lines = terminal.frame().trimEnd().split("\n");
            assert.ok(lines.length <= rows - 1);
            assert.ok(lines.every((line) => Array.from(line).length <= columns));
            assert.equal(terminal.frame().includes("▄"), block);
            assert.match(lines.at(-1)!, /Idle/);
            assert.ok(lines.some((line) => line.includes("›")));
            assert.match(lines.at(-(calculateLayout(columns, rows).promptRows + 2))!, /›/);

            if (block) {
                const title = lines.find((line) => line.includes("Akkco Code"))!;
                assert.ok(
                    Math.abs(title.indexOf("Akkco Code") - (columns - title.trim().length) / 2) <=
                        1,
                    "Header should be centered",
                );
                assert.equal(lines.filter((line) => /[▄▀█]/.test(line)).length, 3);
            }
        } finally {
            terminal.cleanup();
        }
    });
}

test("streaming text stays bounded, PageUp/PageDown inspect the live response, and /clear resets conversation", async () => {
    const content = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    let release = () => {};

    const pause = new Promise<void>((resolve) => {
        release = resolve;
    });

    const terminal = mount(80, 24, createProvider([{ type: "text", content }], pause));

    try {
        assert.equal(terminal.controller.getSnapshot().status, "idle");

        const turn = terminal.controller.submit("long response");
        await waitFor(() => terminal.frame().includes("line 59"));

        assert.equal(uiStatus(terminal.controller.getSnapshot()), "Thinking");

        terminal.input.write("\x1b[5~");
        await waitFor(() => terminal.frame().includes("Response ↑"));

        terminal.input.write("\x1b[6~");
        await waitFor(() => terminal.frame().includes("line 59"));

        terminal.output.columns = 47;
        terminal.output.rows = 12;
        terminal.output.emit("resize");

        await waitFor(
            () => terminal.frame().includes("line 59") && terminal.frame().includes("Thinking"),
        );
        assert.ok(
            terminal
                .frame()
                .split("You\n")
                .at(-1)!
                .split("\n")
                .every((line) => Array.from(line).length <= 47),
        );

        release();
        await turn;

        const assistant = terminal.controller
            .getSnapshot()
            .history.find((item) => item.type === "message" && item.role === "assistant");
        assert.ok(assistant && assistant.type === "message");
        assert.equal(assistant.content, content);

        await terminal.controller.submit("/clear");
        await waitFor(() => terminal.frame().includes("Conversation cleared."));
        assert.equal(terminal.controller.getSnapshot().history.length, 1);
        assert.equal(uiStatus(terminal.controller.getSnapshot()), "Idle");
    } finally {
        release();
        terminal.cleanup();
    }
});

test("navigation and interactive inputs are handled cleanly in inline scrollback mode", async () => {
    const content = Array.from({ length: 40 }, (_, index) => `history_entry_${index}`).join("\n");
    let release = () => {};

    const pause = new Promise<void>((resolve) => {
        release = resolve;
    });

    const terminal = mount(80, 24, createProvider([{ type: "text", content }], pause));

    try {
        const turn = terminal.controller.submit("generate");
        await waitFor(() => terminal.frame().includes("history_entry_39"));

        release();
        await turn;
        await waitFor(() => terminal.controller.getSnapshot().status === "idle");

        // Verify history entries are committed and preserved
        const history = terminal.controller.getSnapshot().history;
        assert.ok(
            history.some(
                (item) => item.type === "message" && item.content.includes("history_entry_39"),
            ),
        );

        // Typing and navigation at prompt work cleanly
        terminal.input.write("/clear");
        await waitFor(() => terminal.frame().includes("/clear"));
        terminal.input.write("\r");
        await waitFor(() => terminal.frame().includes("Conversation cleared."));
        assert.equal(uiStatus(terminal.controller.getSnapshot()), "Idle");
    } finally {
        release();
        terminal.cleanup();
    }
});

test("bracketed paste preserves multiline content and submits only on a deliberate Enter", async () => {
    const terminal = mount(80, 24);

    try {
        await waitFor(() => terminal.rawModes.includes(true));

        terminal.input.write("\x1b[20");
        await new Promise((resolve) => setTimeout(resolve, 20));
        terminal.input.write("0~Review runtime.ts.\r\nUse repository tools.\n");
        await new Promise((resolve) => setTimeout(resolve, 20));
        terminal.input.write("\x1b[201~");

        await waitFor(() => terminal.printed().includes("Use repository tools."));
        assert.equal(terminal.controller.getSnapshot().history.length, 0);

        terminal.input.write("\r");
        await waitFor(() =>
            terminal.controller.getSnapshot().history.some((item) => item.type === "message"),
        );

        const prompts = terminal.controller
            .getSnapshot()
            .history.filter((item) => item.type === "message" && item.role === "user");
        assert.equal(prompts.length, 1);
        assert.ok(prompts[0].type === "message");
        assert.equal(prompts[0].content, "Review runtime.ts.\nUse repository tools.\n");

        await waitFor(() => terminal.controller.getSnapshot().status === "idle");

        terminal.input.write("/exit");
        await waitFor(() => terminal.frame().includes("› /exit"));

        terminal.input.write("\r");
        await terminal.instance.waitUntilExit();

        assert.equal(terminal.controller.getSnapshot().exited, true);
        assert.equal(terminal.rawModes.at(-1), false);
        assert.equal(terminal.input.listenerCount("data"), 0);
    } finally {
        terminal.cleanup();
    }
});

test("input parser buffers split paste markers, preserves unbracketed multiline paste, and decodes navigation", () => {
    const events: TerminalInputEvent[] = [];
    const input = createTerminalInput((event) => events.push(event));

    input("\x1b[200~one\n");
    input("two\n\x1b[20");
    input("1~");
    assert.deepEqual(events, [{ type: "paste", text: "one\ntwo\n" }]);

    input("\r");
    input("three\nfour\n");
    input("\x1b[5~\x1b[6~\x03");
    input("\x1b[5;2~\x1b[<64;5;5M\x1b[<65;5;5M\x1b[M\x60  \x1b[M\x61  ");

    assert.deepEqual(events.slice(1), [
        { type: "key", key: "enter" },
        { type: "paste", text: "three\nfour\n" },
        { type: "key", key: "pageUp" },
        { type: "key", key: "pageDown" },
        { type: "key", key: "interrupt" },
        { type: "key", key: "pageUp" },
        { type: "scroll", direction: "up", lines: 3 },
        { type: "scroll", direction: "down", lines: 3 },
        { type: "scroll", direction: "up", lines: 3 },
        { type: "scroll", direction: "down", lines: 3 },
    ]);

    const draft = promptViewport(Array.from("one\ntwo\nthree"), 13, 20, 2);
    assert.deepEqual(
        draft.map((line) => line.characters.join("")),
        ["two", "three"],
    );
    assert.equal(draft[1].cursor, 5);
});

test("cursor editing and backspace preserve commands", async () => {
    const terminal = mount(80, 24);

    try {
        await waitFor(() => terminal.rawModes.includes(true));

        terminal.input.write("/toolls");
        await waitFor(() => terminal.frame().includes("/toolls"));

        terminal.input.write("\x1b[D");
        await new Promise((resolve) => setTimeout(resolve, 20));
        terminal.input.write("\x7f");

        terminal.input.write("\x1b[C");
        await new Promise((resolve) => setTimeout(resolve, 20));

        terminal.input.write("\r");
        await waitFor(() => terminal.frame().includes("Available tools:"));
        assert.equal(terminal.controller.getSnapshot().status, "idle");
    } finally {
        terminal.cleanup();
    }
});

test("keyboard Ctrl+C preserves cancellation state, permits another turn, and exits when idle", async () => {
    let release = () => {};

    const pause = new Promise<void>((resolve) => {
        release = resolve;
    });

    const terminal = mount(
        80,
        24,
        createProvider([{ type: "text", content: "partial response" }], pause),
    );

    try {
        await waitFor(() => terminal.rawModes.includes(true));

        terminal.input.write("first turn");
        await new Promise((resolve) => setTimeout(resolve, 20));
        terminal.input.write("\r");

        await waitFor(() => terminal.controller.getSnapshot().assistantText === "partial response");

        terminal.input.write("\x03");
        await waitFor(() => terminal.controller.getSnapshot().outcome === "cancelled");

        release();
        await waitFor(() => terminal.controller.getSnapshot().status === "idle");
        assert.equal(uiStatus(terminal.controller.getSnapshot()), "Cancelled");

        assert.equal(
            terminal.controller
                .getSnapshot()
                .history.filter(
                    (item) => item.type === "notice" && item.content === "Generation cancelled.",
                ).length,
            1,
        );

        await terminal.controller.submit("second turn");
        assert.equal(uiStatus(terminal.controller.getSnapshot()), "Idle");

        terminal.input.write("\x03");
        await terminal.instance.waitUntilExit();
        assert.equal(terminal.controller.getSnapshot().exited, true);
        assert.equal(terminal.rawModes.at(-1), false);
    } finally {
        release();
        terminal.cleanup();
    }
});

test("tool states include running and failure; automatic results stay out of the viewport", async () => {
    const terminal = mount(80, 24);

    let fail = (_error: Error) => {};
    const result = new Promise<{ content: string }>((_resolve, reject) => {
        fail = reject;
    });

    terminal.toolRegistry.register({
        ...terminal.toolRegistry.get("read_file")!,
        name: "controlled_tool",
        execute: () => result,
    });

    try {
        const turn = terminal.controller.submit('/tool controlled_tool {"path":"file.txt"}');
        await waitFor(() => terminal.frame().includes("running..."));
        assert.equal(uiStatus(terminal.controller.getSnapshot()), "Running tool");

        fail(new Error("Tool failed for testing"));
        await turn;

        await waitFor(() => terminal.frame().includes("Tool failed for testing"));
        assert.equal(uiStatus(terminal.controller.getSnapshot()), "Error");

        const state = terminal.controller.getSnapshot();
        const lines = buildConversationLines(
            {
                ...state,
                history: [
                    {
                        id: 1,
                        type: "tool",
                        execution: {
                            toolName: "read_file",
                            arguments: { path: "file.txt" },
                            status: "completed",
                            durationMs: 8,
                            result: "secret file contents",
                        },
                    },
                ],
            },
            78,
        );

        assert.ok(lines.some((line) => line.text.includes("✓ completed · 8ms")));
        assert.ok(lines.some((line) => line.text.includes("file.txt")));
        assert.ok(!lines.some((line) => line.text.includes("secret file contents")));
        assert.equal(visibleConversation(lines, 2, 0).lines.length, 2);
        assert.equal(visibleConversation(lines, 2, 999).offset, lines.length - 2);
    } finally {
        fail(new Error("cleanup"));
        terminal.cleanup();
    }
});

test("normal screen cleanup disables paste, restores raw mode and is idempotent", () => {
    const rawModes: boolean[] = [];

    const input = Object.assign(new PassThrough(), {
        isTTY: true,
        isRaw: false,
        setRawMode: (raw: boolean) => {
            rawModes.push(raw);
        },
    });

    const output = new PassThrough();
    let written = "";

    output.on("data", (data) => {
        written += data.toString();
    });

    const restore = enterTerminal(
        input as unknown as typeof process.stdin,
        output as unknown as typeof process.stdout,
    );

    assert.ok(written.includes("\x1b[2J\x1b[H"));
    assert.ok(written.includes("\x1b[?2004h"));
    assert.ok(!written.includes("\x1b[?1007"));

    restore();
    restore();

    assert.deepEqual(rawModes, [false]);
    assert.equal(input.isPaused(), true);
    assert.ok(!written.includes("\x1b[?1049"));
    assert.equal(written.split("\x1b[?2004l").length - 1, 1);
    assert.ok(written.includes("\x1b[?25h"));
    assert.ok(written.includes("\x1b[?2004l"));

    input.destroy();
    output.destroy();
});

test("runtime errors remain visible as UI state and /clear returns to idle", async () => {
    const provider: ModelProvider = {
        id: "failing",
        stream: () => ({
            [Symbol.asyncIterator]: () => ({
                next: async () => {
                    throw new Error("Provider unavailable");
                },
            }),
        }),
    };

    const terminal = mount(80, 24, provider);

    try {
        await terminal.controller.submit("hello");
        assert.equal(uiStatus(terminal.controller.getSnapshot()), "Error");

        await waitFor(() => terminal.frame().includes("Error: Provider unavailable"));

        await terminal.controller.submit("/clear");
        assert.equal(uiStatus(terminal.controller.getSnapshot()), "Idle");
        assert.equal(terminal.controller.getSnapshot().history.length, 1);
    } finally {
        terminal.cleanup();
    }
});

test("draft stays editable during generation, queued prompts run in order, and unsubmitted text survives", async () => {
    let release = () => {};
    const pause = new Promise<void>((resolve) => {
        release = resolve;
    });
    const terminal = mount(
        80,
        24,
        createProvider([{ type: "text", content: "streaming response" }], pause),
    );
    try {
        const turn = terminal.controller.submit("first");
        await waitFor(() => terminal.frame().includes("Thinking"));
        terminal.input.write("next draff");
        terminal.input.write("\x7ft");
        await waitFor(() => terminal.frame().includes("› next draft"));
        assert.equal(terminal.controller.getSnapshot().status, "generating");
        terminal.input.write("\r");
        await waitFor(() => terminal.frame().includes("1 queued"));
        terminal.input.write("\x1b[200~third\nmultiline\x1b[201~");
        terminal.input.write("\r");
        await waitFor(() => terminal.frame().includes("2 queued"));
        terminal.input.write("keep editing");
        await waitFor(() => terminal.frame().includes("keep editing"));
        release();
        await turn;
        await waitFor(() => terminal.frame().includes("Idle"));
        assert.ok(terminal.frame().includes("keep editing"));
        const prompts = terminal.controller
            .getSnapshot()
            .history.filter((item) => item.type === "message" && item.role === "user");
        assert.deepEqual(
            prompts.map((item) => item.type === "message" && item.content),
            ["first", "next draft", "third\nmultiline"],
        );
        assert.deepEqual(terminal.controller.getSnapshot().queuedPrompts, []);
    } finally {
        release();
        terminal.cleanup();
    }
});

test("interrupt, exit, and disposal discard queued turns", async () => {
    for (const action of ["interrupt", "exit", "dispose"] as const) {
        let release = () => {};
        const pause = new Promise<void>((resolve) => {
            release = resolve;
        });
        const terminal = mount(
            80,
            24,
            createProvider([{ type: "text", content: "partial" }], pause),
        );
        try {
            const turn = terminal.controller.submit("first");
            await waitFor(() => terminal.controller.getSnapshot().assistantText === "partial");
            await terminal.controller.submit("must not run");
            await terminal.controller.submit("   ");
            assert.deepEqual(terminal.controller.getSnapshot().queuedPrompts, ["must not run"]);
            terminal.controller[action]();
            release();
            await turn;
            assert.deepEqual(terminal.controller.getSnapshot().queuedPrompts, []);
            assert.ok(
                !terminal.controller
                    .getSnapshot()
                    .history.some(
                        (item) => item.type === "message" && item.content === "must not run",
                    ),
            );
        } finally {
            release();
            terminal.cleanup();
        }
    }
});
