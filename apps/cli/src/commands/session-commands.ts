import type { TranscriptItem } from "@akkco/core";
import type { StoredTranscriptRecord } from "@akkco/retrieval";
import type { CliCommand } from "./command-registry.js";

const validateAndParseRecord = (record: StoredTranscriptRecord): TranscriptItem => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(record.payload);
    } catch {
        throw new Error(`Invalid JSON payload at sequence ${record.sequence}`);
    }

    if (!parsed || typeof parsed !== "object") {
        throw new Error(`Record payload at sequence ${record.sequence} must be an object`);
    }

    const obj = parsed as Record<string, unknown>;
    if (obj.type !== record.type) {
        throw new Error(
            `Record type mismatch at sequence ${record.sequence}: record says "${record.type}" but payload says "${String(obj.type)}"`,
        );
    }

    if (obj.type === "system") {
        if (typeof obj.content !== "string") {
            throw new Error(
                `System message at sequence ${record.sequence} requires string content`,
            );
        }
        return { type: "system", content: obj.content };
    }

    if (obj.type === "user") {
        if (typeof obj.content !== "string") {
            throw new Error(`User message at sequence ${record.sequence} requires string content`);
        }
        return { type: "user", content: obj.content };
    }

    if (obj.type === "assistant") {
        if (typeof obj.content !== "string") {
            throw new Error(
                `Assistant message at sequence ${record.sequence} requires string content`,
            );
        }
        const validStatuses = ["completed", "interrupted", "failed"];
        if (typeof obj.status !== "string" || !validStatuses.includes(obj.status)) {
            throw new Error(
                `Assistant message at sequence ${record.sequence} has invalid status "${String(obj.status)}"`,
            );
        }
        return {
            type: "assistant",
            content: obj.content,
            status: obj.status as "completed" | "interrupted" | "failed",
        };
    }

    if (obj.type === "tool_execution") {
        if (typeof obj.callId !== "string" || typeof obj.toolName !== "string") {
            throw new Error(
                `Tool execution at sequence ${record.sequence} missing callId or toolName`,
            );
        }
        const validStatuses = ["requested", "running", "completed", "failed", "cancelled"];
        if (typeof obj.status !== "string" || !validStatuses.includes(obj.status)) {
            throw new Error(
                `Tool execution at sequence ${record.sequence} has invalid status "${String(obj.status)}"`,
            );
        }
        return {
            type: "tool_execution",
            callId: obj.callId,
            toolName: obj.toolName,
            arguments: obj.arguments,
            result: typeof obj.result === "string" ? obj.result : undefined,
            error: typeof obj.error === "string" ? obj.error : undefined,
            status: obj.status as "requested" | "running" | "completed" | "failed" | "cancelled",
            durationMs: typeof obj.durationMs === "number" ? obj.durationMs : undefined,
        };
    }

    throw new Error(
        `Unsupported transcript record type "${String(obj.type)}" at sequence ${record.sequence}`,
    );
};

export const sessionCommand: CliCommand = {
    name: "session",
    description: "Display the active session ID, transcript length, and useful metadata",
    usage: "/session",
    execute: (_args, context) => {
        const activeSession = context.session;
        const transcriptCount = activeSession.transcript.length;
        const model = context.metadata?.model ?? "unknown";
        const toolMode = context.metadata?.toolMode ?? "unknown";

        context.notice(
            `Active Session:\n` +
                `  ID: ${activeSession.id}\n` +
                `  Transcript: ${transcriptCount} item${transcriptCount === 1 ? "" : "s"}\n` +
                `  Model: ${model}\n` +
                `  Tool Mode: ${toolMode}`,
        );
    },
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Formats a session identifier so that it is readable, compact, and guaranteed unambiguous
 * for subsequent use with /resume <id>.
 */
export const formatUnambiguousSessionId = (id: string, allIds: readonly string[]): string => {
    // 1. If standard UUID: start at 8 chars (e.g. "4cc498fe"). If collision exists in allIds, expand until unique.
    if (UUID_REGEX.test(id)) {
        for (let len = 8; len <= id.length; len++) {
            const candidate = id.slice(0, len);
            const hasConflict = allIds.some((other) => other !== id && other.startsWith(candidate));
            if (!hasConflict) {
                return candidate;
            }
        }
        return id;
    }

    // 2. If non-UUID (e.g. "session-1791542889779", "custom-session"):
    // If the entire ID is reasonably short (<= 24 characters), display the full ID!
    // This avoids trimming "session-1791542889779" into an ambiguous identical "session-".
    if (id.length <= 24) {
        return id;
    }

    // 3. For long custom IDs (> 24 chars): find shortest unique prefix (at least 8 chars).
    for (let len = 8; len < id.length; len++) {
        const candidate = id.slice(0, len);
        const hasConflict = allIds.some((other) => other !== id && other.startsWith(candidate));
        if (!hasConflict) {
            return candidate;
        }
    }

    return id;
};

export const sessionsCommand: CliCommand = {
    name: "sessions",
    description: "List recent persisted sessions, newest first",
    usage: "/sessions",
    execute: async (args, context) => {
        if (!context.store) {
            context.notice("Session persistence is not available.", "warning");
            return;
        }

        const trimmedArgs = args.trim();
        let limit = 20;
        let offset = 0;

        if (trimmedArgs) {
            if (trimmedArgs === "clean" || trimmedArgs === "prune") {
                context.notice(
                    "To safely identify and clean up old automated test sessions:\n" +
                        "  npm run clean:test-sessions          (dry-run preview)\n" +
                        "  npm run clean:test-sessions --apply  (backup and remove transactionally)",
                    "info",
                );
                return;
            }

            const parts = trimmedArgs.split(/\s+/);
            if (parts[0].toLowerCase() === "page" || parts[0].toLowerCase() === "p") {
                const pageNum = Number(parts[1]);
                if (!Number.isInteger(pageNum) || pageNum < 1) {
                    context.notice(
                        "Usage: /sessions page <number> (e.g. /sessions page 2)",
                        "error",
                    );
                    return;
                }
                limit = 20;
                offset = (pageNum - 1) * limit;
            } else if (parts.length === 1) {
                const parsedLimit = Number(parts[0]);
                if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
                    context.notice(
                        "Usage: /sessions [limit] [offset] (e.g. /sessions 20 or /sessions 20 20)",
                        "error",
                    );
                    return;
                }
                limit = Math.min(parsedLimit, 100);
            } else if (parts.length === 2) {
                const parsedLimit = Number(parts[0]);
                const parsedOffset = Number(parts[1]);
                if (
                    !Number.isInteger(parsedLimit) ||
                    parsedLimit < 1 ||
                    !Number.isInteger(parsedOffset) ||
                    parsedOffset < 0
                ) {
                    context.notice(
                        "Usage: /sessions [limit] [offset] (e.g. /sessions 20 or /sessions 20 20)",
                        "error",
                    );
                    return;
                }
                limit = Math.min(parsedLimit, 100);
                offset = parsedOffset;
            } else {
                context.notice(
                    "Usage: /sessions [limit] [offset] (e.g. /sessions 20 or /sessions 20 20)",
                    "error",
                );
                return;
            }
        }

        const sessions = await context.store.listSessions(limit, offset);
        if (sessions.length === 0) {
            if (offset > 0) {
                context.notice(`No sessions found at offset ${offset}.`);
            } else {
                context.notice("No persisted sessions found.");
            }
            return;
        }

        const totalCount =
            typeof context.store.countSessions === "function"
                ? await context.store.countSessions()
                : undefined;

        const allIds = sessions.map((s) => s.id);
        const header =
            totalCount !== undefined
                ? `Persisted Sessions: (showing ${offset + 1}–${offset + sessions.length} of ${totalCount}, newest first)`
                : "Persisted Sessions:";

        const lines = [header];
        for (const s of sessions) {
            const unambiguousId = formatUnambiguousSessionId(s.id, allIds);
            const isActive = s.id === context.session.id;
            const activeTag = isActive ? " (active)" : "";
            const updated = s.updatedAt
                ? s.updatedAt.replace("T", " ").replace(/\.\d+Z$/, "Z")
                : "unknown";
            const count = s.transcriptCount !== undefined ? ` · ${s.transcriptCount} items` : "";
            const preview = s.lastUserPrompt
                ? ` · "${s.lastUserPrompt.replace(/\s+/g, " ").slice(0, 50)}${s.lastUserPrompt.length > 50 ? "…" : ""}"`
                : "";

            lines.push(`  ${unambiguousId} · ${updated}${count}${preview}${activeTag}`);
        }

        if (totalCount !== undefined && offset + sessions.length < totalCount) {
            lines.push(
                `\nUse "/sessions ${limit} ${offset + limit}" or "/sessions page ${Math.floor(offset / limit) + 2}" to view older sessions.`,
            );
        }

        context.notice(lines.join("\n"));
    },
};

export const resumeCommand: CliCommand = {
    name: "resume",
    description: "Restore a saved conversation session by ID or prefix",
    usage: "/resume <session-id>",
    execute: async (args, context) => {
        if (context.isBusy) {
            context.notice("Cannot switch sessions while a generation is in progress.", "error");
            return;
        }

        const targetId = args.trim();
        if (!targetId) {
            context.notice("Usage: /resume <session-id>", "error");
            return;
        }

        if (!context.store || !context.restoreSession) {
            context.notice("Session persistence is not available.", "warning");
            return;
        }

        const matches = await context.store.findSessionsByPrefix(targetId);
        if (matches.length === 0) {
            context.notice(`Session not found: "${targetId}"`, "error");
            return;
        }

        if (matches.length > 1) {
            const ids = matches.map((m) => m.id.slice(0, 8)).join(", ");
            context.notice(`Ambiguous session ID "${targetId}". Matches: ${ids}`, "error");
            return;
        }

        const matchedSession = matches[0];

        try {
            const records = await context.store.getTranscriptItems(matchedSession.id);
            const canonicalTranscript: TranscriptItem[] = [];

            for (const record of records) {
                canonicalTranscript.push(validateAndParseRecord(record));
            }

            const maxSequence = records.reduce((max, r) => Math.max(max, r.sequence), -1);
            const nextSequence = maxSequence >= 0 ? maxSequence + 1 : 0;

            context.restoreSession(matchedSession.id, canonicalTranscript, nextSequence);
            context.notice(
                `Resumed session ${matchedSession.id} (${canonicalTranscript.length} item${canonicalTranscript.length === 1 ? "" : "s"}).`,
            );
        } catch (error) {
            context.notice(
                `Failed to restore session: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
        }
    },
};

export const exitCommand: CliCommand = {
    name: "exit",
    description: "Exit the Akkco Code CLI",
    usage: "/exit",
    execute: (_args, context) => {
        context.exit();
    },
};

export const clearCommand: CliCommand = {
    name: "clear",
    description: "Clear the conversation session and display history",
    usage: "/clear",
    execute: (_args, context) => {
        if (context.resetSession) {
            context.resetSession();
        } else {
            context.session.clear();
        }
        context.clearHistory();
        context.notice("Conversation cleared.");
    },
};

export const sessionCommands = [
    sessionCommand,
    sessionsCommand,
    resumeCommand,
    clearCommand,
    exitCommand,
];
