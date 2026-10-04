import type { Terminal } from "@xterm/headless";
import stringWidth from "string-width";

export class Screen {
    readonly cols: number;
    readonly rows: number;
    readonly cursor: { readonly x: number; readonly y: number };
    private readonly renderedLines: readonly string[];
    private readonly unclippedLines: readonly string[];
    private readonly scrollbackLines: readonly string[];

    constructor(terminal: Terminal) {
        this.cols = terminal.cols;
        this.rows = terminal.rows;
        this.cursor = {
            x: terminal.buffer.active.cursorX,
            y: terminal.buffer.active.cursorY,
        };

        const buffer = terminal.buffer.active;
        const trimmed: string[] = [];
        const raw: string[] = [];
        const all: string[] = [];

        const start = buffer.baseY;
        for (let i = 0; i < terminal.rows; i++) {
            const line = buffer.getLine(start + i);
            trimmed.push(line ? line.translateToString(true) : "");
            raw.push(line ? line.translateToString(false) : "");
        }

        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) {
                all.push(line.translateToString(true));
            }
        }

        this.renderedLines = Object.freeze(trimmed);
        this.unclippedLines = Object.freeze(raw);
        this.scrollbackLines = Object.freeze(all);
    }

    lines = (): readonly string[] => this.renderedLines;

    rawLines = (): readonly string[] => this.unclippedLines;

    allLines = (): readonly string[] => this.scrollbackLines;

    text = (): string => {
        // Strip empty trailing rows at bottom of viewport for clean normalized assertions
        const trimmed = [...this.renderedLines];
        while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.trim() === "") {
            trimmed.pop();
        }
        return trimmed.join("\n");
    };

    scrollbackText = (): string => {
        const trimmed = [...this.scrollbackLines];
        while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.trim() === "") {
            trimmed.pop();
        }
        return trimmed.join("\n");
    };

    rawText = (): string => this.renderedLines.join("\n");

    hasText = (substring: string): boolean =>
        this.text().includes(substring) || this.scrollbackText().includes(substring);

    findLine = (predicate: (line: string) => boolean): string | undefined =>
        this.renderedLines.find(predicate) ?? this.scrollbackLines.find(predicate);

    maxLineWidth = (): number =>
        this.renderedLines.reduce((max, line) => Math.max(max, stringWidth(line)), 0);

    toString = (): string => {
        const border = "─".repeat(Math.max(20, Math.min(80, this.cols)));
        return `${border}\n${this.text()}\n${border}`;
    };
}
