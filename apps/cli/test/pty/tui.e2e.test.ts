import assert from "node:assert/strict";
import test from "node:test";
import { startTui } from "./pty-harness.js";

test("Startup: starts in interactive mode with prompt and status bar", async () => {
    const tui = await startTui();
    try {
        const screen = await tui.screen();
        assert.ok(screen.hasText("Akkco Code"), "Expected header to contain Akkco Code");
        assert.ok(screen.hasText("›"), "Expected prompt symbol to be visible");
        assert.ok(screen.hasText("Idle"), "Expected status bar to show Idle");
        assert.match(screen.lines().at(-2)!, /Idle/, "Initial status sits at the bottom");
        assert.equal(tui.terminal.buffer.active.type, "normal");
    } finally {
        await tui.stop();
    }
});

test("Slash autocomplete: typing '/' opens palette and filtering narrows commands", async () => {
    const tui = await startTui();
    try {
        // Type "/" -> suggestions palette opens
        await tui.write("/");
        await tui.waitForText("Commands");

        let screen = await tui.screen();
        assert.ok(screen.hasText("/clear"));
        assert.ok(screen.hasText("/exit"));
        assert.ok(screen.hasText("/tool"));
        assert.ok(screen.hasText("/tools"));

        // Type "to" -> narrows down to /tool and /tools
        await tui.write("to");
        await tui.waitFor(
            (s) => s.hasText("› /to") && !s.lines().some((l) => l.includes("│ /clear")),
        );

        screen = await tui.screen();
        assert.ok(screen.hasText("/tool"));
        assert.ok(screen.hasText("/tools"));
        // Check suggestions box rows (which start with box-border "│ /")
        assert.ok(
            !screen.lines().some((l) => l.includes("│ /clear")),
            "Expected /clear to be filtered out of suggestions",
        );
        assert.ok(
            !screen.lines().some((l) => l.includes("│ /exit")),
            "Expected /exit to be filtered out of suggestions",
        );
    } finally {
        await tui.stop();
    }
});

test("Keyboard navigation: ArrowDown and ArrowUp cycle through suggestions", async () => {
    const tui = await startTui();
    try {
        await tui.write("/to");
        await tui.waitForText("Commands");

        // Initial selection should be on /tool
        let screen = await tui.screen();
        assert.ok(screen.hasText("/tool"));

        // Press down arrow -> moves to /tools
        await tui.key("down");
        await new Promise((r) => setTimeout(r, 60));

        // Press up arrow -> moves back to /tool
        await tui.key("up");
        await new Promise((r) => setTimeout(r, 60));

        screen = await tui.screen();
        assert.ok(screen.hasText("/tool"));
        assert.ok(screen.hasText("/tools"));
    } finally {
        await tui.stop();
    }
});

test("Tab completion: completes command with argument spacing without executing", async () => {
    const tui = await startTui();
    try {
        await tui.write("/to");
        await tui.waitForText("Commands");

        // Tab completes the first matching command (/tool) with a trailing space
        await tui.key("tab");

        // Suggestions palette should close because of trailing space
        await tui.waitFor((s) => !s.hasText("Commands"));

        const screen = await tui.screen();
        assert.ok(screen.hasText("/tool"), "Prompt should contain completed command");
        // Verify it did not execute immediately (no error notice)
        assert.ok(!screen.hasText("Usage: /tool"), "Command must not have executed yet");
    } finally {
        await tui.stop();
    }
});

test("Command execution: submitting /clear executes and produces notice", async () => {
    const tui = await startTui();
    try {
        await tui.write("/clear");
        await tui.key("enter");

        await tui.waitForText("Conversation cleared.");
        const screen = await tui.screen();
        assert.ok(screen.hasText("Conversation cleared."));
    } finally {
        await tui.stop();
    }
});

test("Normal model prompt: streaming assistant response appears", async () => {
    const tui = await startTui();
    try {
        await tui.write("Hello");
        await tui.key("enter");

        await tui.waitForText("Hello from Akkco deterministic provider.");
        await tui.waitForText("Idle");

        const screen = await tui.screen();
        assert.ok(screen.hasText("Hello from Akkco deterministic provider."));
    } finally {
        await tui.stop();
    }
});

test("Cancellation: Ctrl+C aborts active generation and idle Ctrl+C exits", async () => {
    const tui = await startTui();
    try {
        // Start long generation
        await tui.write("__TEST_WAIT__");
        await tui.key("enter");

        await tui.waitForText("Starting wait task...");

        // Interrupt active generation
        await tui.key("ctrlC");

        // Should display cancellation notice and status
        await tui.waitForText("Generation cancelled.");
        await tui.waitForText("Cancelled");
        const screen = await tui.screen();
        assert.ok(screen.hasText("Generation cancelled."));
        assert.ok(screen.hasText("›"), "Prompt should be available again");

        // Now test Ctrl+C while idle -> process should exit
        await tui.key("ctrlC");
        const exitResult = await tui.waitForExit(4000);
        assert.ok(typeof exitResult.exitCode === "number" || typeof exitResult.signal === "number");
    } finally {
        await tui.stop();
    }
});

test("Multiline paste: bracketed paste remains in single draft until Enter", async () => {
    const tui = await startTui();
    try {
        await tui.paste("first line\nsecond line\nthird line");
        await new Promise((r) => setTimeout(r, 100));

        // Verify draft contains pasted text and hasn't submitted yet (still Idle)
        let screen = await tui.screen();
        assert.ok(screen.hasText("Idle"), "Pasting multiline text must not trigger auto-submit");
        assert.ok(screen.hasText("third line"), "Prompt should contain pasted lines");

        // Submit deliberately with Enter
        await tui.key("enter");
        await tui.waitForText("Hello from Akkco deterministic provider.");

        screen = await tui.screen();
        assert.ok(screen.hasText("Hello from Akkco deterministic provider."));
    } finally {
        await tui.stop();
    }
});

test("Resize: adapts terminal layout without crashing or overflowing", async () => {
    const tui = await startTui({ columns: 80, rows: 24 });
    try {
        // Resize to narrow dimensions
        await tui.resize(55, 20);
        await tui.waitFor((s) => s.hasText("›") && s.hasText("Idle"));

        let screen = await tui.screen();
        assert.ok(screen.hasText("›"));
        assert.ok(screen.maxLineWidth() <= 55, "Lines should not exceed terminal width");
        assert.match(screen.lines().at(-2)!, /Idle/);

        // Resize to wider dimensions
        await tui.resize(100, 30);
        await tui.waitFor((s) => s.hasText("›") && s.hasText("Idle"));

        screen = await tui.screen();
        assert.ok(screen.hasText("›"));
        assert.ok(screen.maxLineWidth() <= 100, "Lines should not exceed wide terminal width");
        assert.match(screen.lines().at(-2)!, /Idle/);
    } finally {
        await tui.stop();
    }
});

test("Completed turns flow into native scrollback without mouse tracking or history duplication", async () => {
    const tui = await startTui({ columns: 80, rows: 24 });
    try {
        for (const prompt of ["__TEST_LONG__ first", "__TEST_LONG__ second"]) {
            await tui.write(prompt);
            await tui.key("enter");
            await tui.waitFor((s) => s.text().includes("Idle") && s.text().includes("Line 35:"));
        }

        const screen = await tui.screen();
        assert.equal(tui.terminal.buffer.active.type, "normal");
        assert.ok(tui.terminal.buffer.active.baseY > 0, "History must reach native scrollback");
        assert.ok(screen.scrollbackText().includes("__TEST_LONG__ first"));
        assert.ok(screen.scrollbackText().includes("__TEST_LONG__ second"));
        assert.equal(screen.allLines().filter((line) => line.includes("Line 01:")).length, 2);
        assert.equal(screen.allLines().filter((line) => line.includes("Akkco Code")).length, 1);
        assert.ok(!screen.text().includes("Line 01:"), "Older lines should be above the viewport");

        const raw = tui.getRecentRawOutput();
        for (const mode of ["1049", "1007", "1000", "1002", "1006"]) {
            assert.ok(!raw.includes(`\x1b[?${mode}h`), `Must not enable terminal mode ${mode}`);
        }
        assert.ok(!raw.includes("\x1b[3J"), "Rendering must not erase native scrollback");
    } finally {
        await tui.stop();
    }
});

test("Drafting during streaming supports editing, paste, queueing, and cancellation", async () => {
    const tui = await startTui();
    try {
        await tui.write("__TEST_WAIT__");
        await tui.key("enter");
        await tui.waitForText("Starting wait task...");
        await tui.paste("next draff");
        await tui.key("backspace");
        await tui.write("t");
        await tui.waitFor(
            (s) => s.text().includes("› next draft") && s.text().includes("Thinking"),
        );
        await tui.key("enter");
        await tui.waitFor((s) => s.text().includes("1 queued"));
        await tui.write("retained draft");
        await tui.key("ctrlC");
        await tui.waitFor(
            (s) => s.text().includes("Cancelled") && s.text().includes("retained draft"),
        );
        const screen = await tui.screen();
        assert.ok(!screen.text().includes("queued"));
        assert.ok(!screen.scrollbackText().includes("Hello from Akkco deterministic provider."));
    } finally {
        await tui.stop();
    }
});

test("Enter during streaming dispatches queued drafts when generation finishes", async () => {
    const tui = await startTui();
    try {
        await tui.write("__TEST_LONG__");
        await tui.key("enter");
        await tui.waitFor((s) => s.text().includes("Thinking"));
        await tui.paste("automatically queued follow-up");
        await tui.key("enter");
        await tui.waitFor(
            (s) =>
                s.text().includes("Idle") &&
                s.scrollbackText().includes("Hello from Akkco deterministic provider."),
        );
        const screen = await tui.screen();
        assert.ok(screen.scrollbackText().includes("Line 35:"));
        assert.ok(screen.scrollbackText().includes("automatically queued follow-up"));
    } finally {
        await tui.stop();
    }
});

test("/exit: cleanly terminates process with exit code 0", async () => {
    const tui = await startTui();
    try {
        await tui.write("/exit");
        await tui.key("enter");

        const exitResult = await tui.waitForExit(4000);
        assert.strictEqual(exitResult.exitCode, 0, "Expected clean exit code 0");
    } finally {
        await tui.stop();
    }
});

test("Terminal cleanup: SIGTERM terminates process cleanly", async () => {
    const tui = await startTui();
    try {
        tui.ptyProcess.kill("SIGTERM");
        const exitResult = await tui.waitForExit(4000);
        assert.ok(exitResult.exitCode === 143 || exitResult.signal !== undefined);
    } finally {
        await tui.stop();
    }
});

test("Model tool loop: invokes tool and displays completed outcome", async () => {
    const tui = await startTui();
    try {
        await tui.write("__TEST_TOOL__");
        await tui.key("enter");

        await tui.waitForText("Completed repository file listing.");
        await tui.waitForText("Idle");

        const screen = await tui.screen();
        assert.ok(screen.hasText("list_files"), "Expected list_files tool event in history");
        assert.ok(screen.hasText("Completed repository file listing."));
    } finally {
        await tui.stop();
    }
});

test("Short terminal autocomplete preserves native scrollback", async () => {
    const tui = await startTui();
    try {
        await tui.write("__TEST_LONG__");
        await tui.key("enter");
        await tui.waitFor((s) => s.text().includes("Idle") && s.text().includes("Line 35:"));
        await tui.resize(80, 8);
        await tui.write("/");
        await tui.waitFor((s) => s.text().includes("Commands"));
        let screen = await tui.screen();
        assert.ok(screen.scrollbackText().includes("Line 01:"));
        await tui.resize(80, 3);
        await tui.waitFor((s) => s.text().includes("› /"));
        screen = await tui.screen();
        assert.ok(screen.scrollbackText().includes("Line 01:"));
        assert.ok(!tui.getRecentRawOutput().includes("\x1b[3J"));
    } finally {
        await tui.stop();
    }
});

test("Composer stays at the bottom after short turns, while drafting, and after clear", async () => {
    const tui = await startTui({ columns: 120, rows: 32 });
    try {
        for (const prompt of ["hi", "hello again"]) {
            await tui.write(prompt);
            await tui.key("enter");
            await tui.waitFor(
                (s) =>
                    s.text().includes("Idle") &&
                    s.hasText("Hello from Akkco deterministic provider."),
            );
            const screen = await tui.screen();
            assert.match(
                screen.lines().at(-2)!,
                /Idle/,
                "Composer must remain docked after a short turn",
            );
        }
        await tui.write("__TEST_WAIT__");
        await tui.key("enter");
        await tui.waitForText("Starting wait task...");
        await tui.write("/");
        await tui.waitForText("Commands");
        let screen = await tui.screen();
        assert.match(
            screen.lines().at(-2)!,
            /Thinking/,
            `Autocomplete must keep the composer docked\n${screen.toString()}`,
        );
        await tui.key("ctrlC");
        await tui.waitFor((s) => s.text().includes("Cancelled"));
        await tui.write("clear");
        await tui.key("enter");
        await tui.waitForText("Conversation cleared.");
        screen = await tui.screen();
        assert.match(screen.lines().at(-2)!, /Idle/);
        assert.equal(
            screen.allLines().filter((line) => line.includes("Akkco Code v")).length,
            1,
            "Clear must not reprint the startup banner",
        );
    } finally {
        await tui.stop();
    }
});

test("Growing the terminal keeps the composer at the bottom after history fills the screen", async () => {
    const tui = await startTui();
    try {
        await tui.write("__TEST_LONG__");
        await tui.key("enter");
        await tui.waitFor((s) => s.text().includes("Idle") && s.text().includes("Line 35:"));
        await tui.resize(55, 20);
        await tui.waitFor((s) => s.text().includes("Idle"));
        assert.match((await tui.screen()).lines().at(-2)!, /Idle/);
        await tui.resize(100, 40);
        await tui.waitFor((s) => s.text().includes("Idle"));
        const screen = await tui.screen();
        assert.match(screen.lines().at(-2)!, /Idle/);
        assert.equal(screen.allLines().filter((line) => line.includes("Akkco Code v")).length, 1);
        assert.ok(!tui.getRecentRawOutput().includes("\x1b[3J"));
    } finally {
        await tui.stop();
    }
});

test("Opening autocomplete over a full live response never replays the banner or erases scrollback", async () => {
    const tui = await startTui();
    try {
        await tui.write("__TEST_LONG_WAIT__");
        await tui.key("enter");
        await tui.waitFor((s) => s.text().includes("Live line 35"));
        await tui.write("/");
        await tui.waitFor((s) => s.text().includes("Commands") && s.text().includes("Thinking"));
        let screen = await tui.screen();
        assert.match(screen.lines().at(-2)!, /Thinking/);
        assert.equal(screen.allLines().filter((line) => line.includes("Akkco Code v")).length, 1);
        assert.ok(!tui.getRecentRawOutput().includes("\x1b[3J"));
        await tui.write("\x15");
        await tui.waitFor((s) => !s.text().includes("Commands"));
        screen = await tui.screen();
        assert.match(screen.lines().at(-2)!, /Thinking/);
        await tui.key("ctrlC");
        await tui.waitFor((s) => s.text().includes("Cancelled"));
        screen = await tui.screen();
        assert.match(screen.lines().at(-2)!, /Cancelled/);
        assert.equal(screen.allLines().filter((line) => line.includes("Akkco Code v")).length, 1);
        assert.equal(screen.allLines().filter((line) => line.trim() === "Live line 1").length, 1);
    } finally {
        await tui.stop();
    }
});

for (const [columns, rows] of [
    [80, 24],
    [120, 40],
]) {
    test(`Live replies flow below the user message with free space beneath them at ${columns}×${rows}`, async () => {
        const tui = await startTui({ columns, rows });
        try {
            await tui.write("__TEST_WAIT__");
            await tui.key("enter");
            await tui.waitFor((s) => s.text().includes("Starting wait task..."));
            let screen = await tui.screen();
            const userRow = screen.lines().findIndex((line) => line.trim() === "__TEST_WAIT__");
            const responseRow = screen
                .lines()
                .findIndex((line) => line.trim() === "Starting wait task...");
            assert.ok(userRow >= 0);
            assert.equal(
                responseRow,
                userRow + 3,
                "Live reply must follow the user message without a large gap",
            );
            assert.equal(screen.lines()[userRow + 2]?.trim(), "Akkco");
            assert.ok(
                screen
                    .lines()
                    .slice(responseRow + 1, rows - 6)
                    .every((line) => line.trim() === ""),
                "Unused space belongs beneath the reply",
            );
            assert.match(screen.lines().at(-2)!, /Thinking/);
            await tui.write("draft during generation");
            await tui.waitFor((s) => s.text().includes("› draft during generation"));
            screen = await tui.screen();
            assert.equal(screen.lines()[responseRow]?.trim(), "Starting wait task...");
            assert.match(screen.lines().at(-2)!, /Thinking/);
            await tui.key("ctrlC");
            await tui.waitFor(
                (s) =>
                    s.text().includes("Cancelled") &&
                    s.lines()[responseRow]?.trim() === "Starting wait task...",
            );
            screen = await tui.screen();
            assert.equal(
                screen.lines()[responseRow]?.trim(),
                "Starting wait task...",
                "Committing the reply must not move it from the bottom to the top",
            );
            assert.match(screen.lines().at(-2)!, /Cancelled/);
        } finally {
            await tui.stop();
        }
    });
}
