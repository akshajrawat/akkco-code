import process, { stdin, stdout } from "node:process";

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

    // Enter alternate screen, home cursor, hide cursor, bracketed paste, mouse tracking & alternate scroll mode.
    output.write(
        "\x1b[?1049h\x1b[H\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h",
    );

    return restore;
};
