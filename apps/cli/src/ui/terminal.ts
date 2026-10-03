import { spawn } from "node:child_process";
import process, { stdin, stdout } from "node:process";

export const copyToClipboard = (
    text: string,
    output: { write: (chunk: string) => unknown } = stdout,
) => {
    if (!text) {
        return;
    }

    // 1. OSC 52 sequence for terminal emulators supporting it
    try {
        const base64 = Buffer.from(text).toString("base64");
        output.write(`\x1b]52;c;${base64}\x07\x1b]52;p;${base64}\x07`);
    } catch {}

    // 2. Desktop clipboard integration (Linux/macOS)
    if (process.platform === "linux") {
        try {
            const tool = process.env.WAYLAND_DISPLAY ? "wl-copy" : "xclip";
            const args = tool === "wl-copy" ? [] : ["-selection", "clipboard"];
            const child = spawn(tool, args, { stdio: ["pipe", "ignore", "ignore"] });
            child.on("error", () => {});
            child.stdin?.end(text);
        } catch {}
    } else if (process.platform === "darwin") {
        try {
            const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
            child.on("error", () => {});
            child.stdin?.end(text);
        } catch {}
    }
};

export const enterTerminal = (input = stdin, output = stdout) => {
    const wasRaw = Boolean(input.isRaw);
    let restored = false;

    const restore = () => {
        if (restored) {
            return;
        }

        restored = true;

        try {
            if (input.isTTY) {
                input.setRawMode(wasRaw);
            }
        } finally {
            input.pause();
            input.unref?.();

            // Disable mouse tracking, alternate scroll, bracketed paste, reset styling, show cursor, restore shell screen.
            output.write(
                "\x1b[?1007l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l",
            );

            process.off("exit", restore);
            process.off("uncaughtExceptionMonitor", restore);
        }
    };

    process.once("exit", restore);
    process.once("uncaughtExceptionMonitor", restore);

    // Enter alternate screen, home cursor, hide cursor, bracketed paste & alternate scroll mode.
    // NOTE: Mouse tracking (?1000h / ?1002h / ?1006h) is intentionally omitted so the terminal
    // preserves native mouse text selection (click and drag) and clipboard copy.
    output.write("\x1b[?1049h\x1b[H\x1b[?25l\x1b[?2004h\x1b[?1007h");

    return restore;
};
