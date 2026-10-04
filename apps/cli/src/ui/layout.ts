import { homedir } from "node:os";
import { sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { CliViewState, ToolExecutionState } from "../state/types.js";

export type ConversationLine = {
    text: string;
    tone: "user" | "assistant" | "tool" | "success" | "warning" | "error" | "muted";
    bold?: boolean;
};

export interface TerminalLayout {
    width: number;
    height: number;
    blockLogo: boolean;
    headerHeight: number;
    promptRows: number;
    footerHeight: number;
    conversationHeight: number;
}

export const calculateLayout = (columns = 80, rows = 24): TerminalLayout => {
    const width = Math.max(1, Math.floor(columns) || 80);

    // Ink adds a trailing newline. Bound live redraws so it never clears native scrollback.
    const height = Math.max(1, (Math.floor(rows) || 24) - 1);
    const blockLogo = width >= 52 && height >= 20;

    const headerHeight = blockLogo ? 7 : height >= 12 ? 4 : height >= 6 ? 2 : 0;
    const promptRows = height >= 14 ? 2 : 1;
    const promptBoxHeight = promptRows + (height < 3 || width < 10 ? 0 : 2);
    const statusBarHeight = height >= 6 ? 1 : 0;
    const footerHeight = Math.min(height, promptBoxHeight + statusBarHeight);

    return {
        width,
        height,
        blockLogo,
        headerHeight,
        promptRows,
        footerHeight,
        conversationHeight: Math.max(0, height - headerHeight - footerHeight),
    };
};

export const fitLine = (text: string, width: number) => {
    const clean = stripVTControlCharacters(text).replace(/[\r\n\t]+/g, " ");

    if (stringWidth(clean) <= width) {
        return clean;
    }

    let result = "";
    for (const character of clean) {
        if (stringWidth(result + character) > width - 1) {
            break;
        }

        result += character;
    }

    return width > 0 ? result + "…" : "";
};

export const displayDirectory = (cwd: string, home = homedir()) => {
    if (cwd === home) {
        return "~";
    }

    if (cwd.startsWith(home + sep)) {
        return "~" + cwd.slice(home.length);
    }

    return cwd;
};

export const toolArgumentSummary = (execution: ToolExecutionState) => {
    const args = execution.arguments;

    if (args && typeof args === "object") {
        const fields = args as Record<string, unknown>;

        if (typeof fields.query === "string") {
            return `"${fields.query}"${typeof fields.path === "string" ? ` in ${fields.path}` : ""}`;
        }

        if (typeof fields.path === "string") {
            return fields.path;
        }
    }

    return JSON.stringify(args) ?? "";
};

export const toolOutcome = (execution: ToolExecutionState) => {
    const duration = execution.durationMs === undefined ? "" : ` · ${execution.durationMs}ms`;

    if (execution.status === "running") {
        return "◌ running...";
    }

    if (execution.status === "cancelled") {
        return "⊘ cancelled";
    }

    if (execution.status === "failed") {
        return `✗ Error: ${execution.error ?? "Tool failed"}${duration}`;
    }

    if (execution.toolName === "search_text" && execution.result !== undefined) {
        const matches =
            execution.result === "No matches found."
                ? 0
                : execution.result
                      .split("\n")
                      .filter((line) => line && !line.startsWith("[Results truncated:")).length;

        return `✓ ${matches} matches${duration}`;
    }

    return `✓ completed${duration}`;
};

export const buildConversationLines = (state: CliViewState, width: number) => {
    const lines: ConversationLine[] = [];

    const add = (text: string, tone: ConversationLine["tone"], bold = false) => {
        const clean = stripVTControlCharacters(text).replace(/\r\n?/g, "\n");
        const wrappedLines = wrapAnsi(clean, Math.max(1, width), {
            hard: true,
            trim: false,
        }).split("\n");

        for (const line of wrappedLines) {
            lines.push({ text: line, tone, bold });
        }
    };

    const message = (role: "user" | "assistant", content: string) => {
        add(role === "user" ? "You" : "Akkco", role, true);
        add(content, role);
    };

    const tool = (execution: ToolExecutionState) => {
        add(fitLine(`● ${execution.toolName}`, width), "tool", true);
        add(fitLine(`  ${toolArgumentSummary(execution)}`, width), "muted");
        add(
            `  ${toolOutcome(execution)}`,
            execution.status === "completed"
                ? "success"
                : execution.status === "failed"
                  ? "error"
                  : "warning",
        );

        if (execution.showResult && execution.result !== undefined) {
            add(execution.result, "muted");
        }
    };

    for (const item of state.history) {
        if (item.type === "message") {
            message(item.role, item.content);
        } else if (item.type === "tool") {
            tool(item.execution);
        } else if (item.type === "notice") {
            add(item.content, item.kind === "info" ? "muted" : item.kind);
        } else {
            add(item.tools.length ? "Available tools:" : "No tools available.", "tool", true);

            for (const entry of item.tools) {
                add(`${entry.name}: ${entry.description}`, "muted");
            }
        }

        lines.push({ text: "", tone: "muted" });
    }

    if (state.assistantText) {
        message("assistant", state.assistantText);
    }

    if (state.activeTool) {
        tool(state.activeTool);
    }

    return lines;
};

export const visibleConversation = (lines: ConversationLine[], height: number, offset: number) => {
    const boundedOffset = Math.min(Math.max(0, offset), Math.max(0, lines.length - height));
    const end = lines.length - boundedOffset;

    return {
        lines: height > 0 ? lines.slice(Math.max(0, end - height), end) : [],
        offset: boundedOffset,
    };
};

export const uiStatus = (state: CliViewState) => {
    if (state.outcome === "cancelled") {
        return "Cancelled";
    }

    if (state.status === "tool") {
        return "Running tool";
    }

    if (state.status === "generating") {
        return "Thinking";
    }

    if (state.outcome === "error") {
        return "Error";
    }

    return "Idle";
};

export const promptViewport = (
    characters: string[],
    cursor: number,
    width: number,
    height: number,
) => {
    const rows: { characters: string[]; cursor?: number }[] = [{ characters: [] }];
    let cursorRow = 0;

    for (let index = 0; index <= characters.length; index++) {
        let row = rows[rows.length - 1]!;
        const character = characters[index];

        if (
            character !== "\n" &&
            stringWidth(row.characters.join("") + (character ?? " ")) > width &&
            row.characters.length
        ) {
            row = { characters: [] };
            rows.push(row);
        }

        if (index === cursor) {
            row.cursor = row.characters.length;
            cursorRow = rows.length - 1;
        }

        if (character === "\n") {
            rows.push({ characters: [] });
        } else if (character !== undefined) {
            row.characters.push(character);
        }
    }

    const start = Math.max(0, cursorRow - height + 1);

    return rows.slice(start, start + height);
};
