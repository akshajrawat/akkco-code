import type { Terminal as TerminalInstance } from "@xterm/headless";
import xtermPkg from "@xterm/headless";
import * as pty from "node-pty";
import path from "node:path";
import process from "node:process";
import { Screen } from "./screen.js";

type TerminalConstructor = new (options?: unknown) => TerminalInstance;
const Terminal: TerminalConstructor =
    (xtermPkg as { Terminal?: TerminalConstructor; default?: { Terminal: TerminalConstructor } })
        .Terminal ??
    (xtermPkg as unknown as { default: { Terminal: TerminalConstructor } }).default?.Terminal ??
    (xtermPkg as unknown as TerminalConstructor);

export type KeyName =
    | "enter"
    | "tab"
    | "escape"
    | "up"
    | "down"
    | "left"
    | "right"
    | "pageUp"
    | "pageDown"
    | "home"
    | "end"
    | "backspace"
    | "delete"
    | "ctrlC"
    | "ctrlA";

const keySequences: Record<KeyName, string> = {
    enter: "\r",
    tab: "\t",
    escape: "\x1b",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
    home: "\x1b[H",
    end: "\x1b[F",
    pageUp: "\x1b[5~",
    pageDown: "\x1b[6~",
    backspace: "\x7f",
    delete: "\x1b[3~",
    ctrlC: "\x03",
    ctrlA: "\x01",
};

export type PtyHarnessOptions = {
    columns?: number;
    rows?: number;
    env?: Record<string, string | undefined>;
    cwd?: string;
    defaultTimeoutMs?: number;
};

export class PtyHarness {
    readonly ptyProcess: pty.IPty;
    readonly terminal: TerminalInstance;
    readonly defaultTimeoutMs: number;

    private readonly recentChunks: string[] = [];
    private isExited = false;
    private exitResult: { exitCode: number; signal?: number } | null = null;
    private readonly exitPromise: Promise<{ exitCode: number; signal?: number }>;
    private resolveExit!: (res: { exitCode: number; signal?: number }) => void;

    constructor(
        ptyProcess: pty.IPty,
        terminal: TerminalInstance,
        options: { defaultTimeoutMs?: number } = {},
    ) {
        this.ptyProcess = ptyProcess;
        this.terminal = terminal;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 8000;

        this.exitPromise = new Promise((resolve) => {
            this.resolveExit = resolve;
        });

        this.ptyProcess.onData((data) => {
            this.terminal.write(data);
            this.recentChunks.push(data);
            if (this.recentChunks.length > 100) {
                this.recentChunks.shift();
            }
        });

        this.ptyProcess.onExit(({ exitCode, signal }) => {
            this.isExited = true;
            this.exitResult = { exitCode, signal };
            this.resolveExit({ exitCode, signal });
        });
    }

    write = async (text: string): Promise<void> => {
        this.ptyProcess.write(text);
        await new Promise((resolve) => setTimeout(resolve, 30));
    };

    key = async (name: KeyName): Promise<void> => {
        const seq = keySequences[name];
        if (!seq) {
            throw new Error(`Unknown key name: ${name}`);
        }
        await this.write(seq);
    };

    paste = async (text: string): Promise<void> => {
        await this.write(`\x1b[200~${text}\x1b[201~`);
    };

    resize = async (columns: number, rows: number): Promise<void> => {
        this.ptyProcess.resize(columns, rows);
        this.terminal.resize(columns, rows);
        await new Promise((resolve) => setTimeout(resolve, 60));
    };

    screen = async (): Promise<Screen> => {
        await new Promise<void>((resolve) => this.terminal.write("", resolve));
        return new Screen(this.terminal);
    };

    getRecentRawOutput = (): string => this.recentChunks.join("");

    waitFor = async (
        predicate: (screen: Screen) => boolean,
        options: { timeout?: number; message?: string } = {},
    ): Promise<Screen> => {
        const timeout = options.timeout ?? this.defaultTimeoutMs;
        const message = options.message ?? "condition to be met";
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
            const current = await this.screen();
            if (predicate(current)) {
                return current;
            }
            await new Promise((resolve) => setTimeout(resolve, 35));
        }

        const finalScreen = await this.screen();
        throw new Error(
            `Timeout (${timeout}ms) waiting for: ${message}\n\n` +
                `Current screen:\n${finalScreen.toString()}\n\n` +
                `Recent raw output:\n${this.getRecentRawOutput()}`,
        );
    };

    waitForText = async (text: string, timeout?: number): Promise<Screen> =>
        this.waitFor((screen) => screen.hasText(text), {
            timeout,
            message: `screen to contain "${text}"`,
        });

    waitForExit = async (timeout = 5000): Promise<{ exitCode: number; signal?: number }> => {
        if (this.exitResult) {
            return this.exitResult;
        }

        const deadline = new Promise<never>((_, reject) =>
            setTimeout(
                () =>
                    reject(
                        new Error(
                            `Timeout (${timeout}ms) waiting for process to exit.\n` +
                                `Recent raw output:\n${this.getRecentRawOutput()}`,
                        ),
                    ),
                timeout,
            ),
        );

        return Promise.race([this.exitPromise, deadline]);
    };

    stop = async (): Promise<void> => {
        if (this.isExited) {
            this.terminal.dispose();
            return;
        }

        try {
            this.ptyProcess.write("\x03");
            const exited = await Promise.race([
                this.exitPromise,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
            ]);

            if (exited === null && !this.isExited) {
                this.ptyProcess.kill("SIGTERM");
                await Promise.race([
                    this.exitPromise,
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
                ]);
            }

            if (!this.isExited) {
                this.ptyProcess.kill("SIGKILL");
                await Promise.race([
                    this.exitPromise,
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
                ]);
            }
        } catch {
            // Child process already terminated
        } finally {
            this.terminal.dispose();
        }
    };
}

export const startTui = async (options: PtyHarnessOptions = {}): Promise<PtyHarness> => {
    const columns = options.columns ?? 80;
    const rows = options.rows ?? 24;

    const repoRoot = path.resolve(import.meta.dirname, "../../../../");
    const tsxPath = path.resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
    const cliPath = path.resolve(repoRoot, "apps/cli/src/index.ts");

    const terminal = new Terminal({
        cols: columns,
        rows,
        allowProposedApi: true,
    });

    const ptyProcess = pty.spawn(process.execPath, [tsxPath, cliPath], {
        name: "xterm-256color",
        cols: columns,
        rows,
        cwd: options.cwd ?? repoRoot,
        env: {
            ...process.env,
            AKKCO_TEST_PROVIDER: "1",
            TERM: "xterm-256color",
            FORCE_COLOR: "1",
            ...options.env,
        },
    });

    const harness = new PtyHarness(ptyProcess, terminal, {
        defaultTimeoutMs: options.defaultTimeoutMs,
    });

    // Wait until startup completes and initial prompt appears
    await harness.waitFor(
        (screen) =>
            screen.hasText("Ask Akkco anything…") ||
            (screen.hasText("›") && screen.hasText("Idle")),
        {
            timeout: 10000,
            message: "initial TUI startup prompt",
        },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    return harness;
};
