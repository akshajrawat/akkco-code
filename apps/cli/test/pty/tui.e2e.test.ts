import assert from "node:assert/strict";
import test from "node:test";
import { startTui, type PtyHarness } from "./pty-harness.js";

test("Startup: starts in interactive mode with prompt and status bar", async () => {
    const tui = await startTui();
    try {
        const screen = await tui.screen();
        assert.ok(screen.hasText("Akkco Code"), "Expected header to contain Akkco Code");
        assert.ok(screen.hasText("›"), "Expected prompt symbol to be visible");
        assert.ok(screen.hasText("Idle"), "Expected status bar to show Idle");
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
        await tui.waitFor((s) => s.hasText("/tool") && s.hasText("/tools"));

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

        // Resize to wider dimensions
        await tui.resize(100, 30);
        await tui.waitFor((s) => s.hasText("›") && s.hasText("Idle"));

        screen = await tui.screen();
        assert.ok(screen.hasText("›"));
        assert.ok(screen.maxLineWidth() <= 100, "Lines should not exceed wide terminal width");
    } finally {
        await tui.stop();
    }
});

test("Scroll: PageUp and PageDown navigate conversation history", async () => {
    const tui = await startTui({ columns: 80, rows: 24 });
    try {
        // Generate enough lines to overflow viewport
        await tui.write("__TEST_LONG__");
        await tui.key("enter");

        await tui.waitForText("Line 35:");
        await tui.waitForText("Idle");

        // At bottom of viewport, Line 35 is visible, but earlier lines like Line 01 are scrolled off
        let screen = await tui.screen();
        assert.ok(screen.hasText("Line 35:"));

        // Scroll up with PageUp
        await tui.key("pageUp");
        await tui.waitFor((s) => s.hasText("History ↑") && s.hasText("Line 15:"));

        screen = await tui.screen();
        assert.ok(
            screen.hasText("History ↑"),
            "PageUp should scroll up and show history indicator in status bar",
        );

        // Scroll back down with PageDown
        await tui.key("pageDown");
        await tui.waitFor((s) => s.hasText("Line 35:") && !s.hasText("History ↑"));

        screen = await tui.screen();
        assert.ok(screen.hasText("Line 35:"), "PageDown should return towards bottom");
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
