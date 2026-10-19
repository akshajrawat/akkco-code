import type { ModelItem, ModelProfile, ModelProvider, ModelRequest } from "@akkco/models";
import type { ConversationStore } from "@akkco/retrieval";
import { estimateModelItemTokens, estimateTokens } from "./token-estimator.js";

export interface StructuredSummary {
    readonly taskOrInvestigation: string;
    readonly importantFindings: readonly string[];
    readonly filesAndLocations: readonly string[];
    readonly decisions: readonly string[];
    readonly failedApproaches: readonly string[];
    readonly unresolvedIssues: readonly string[];
    readonly nextSteps: readonly string[];
    readonly omissions: string;
    readonly sourceRange: {
        readonly sessionId?: string;
        readonly startSequence: number;
        readonly endSequence: number;
    };
}

export interface CompactHistoryOptions {
    readonly items: readonly ModelItem[];
    readonly startSequence: number;
    readonly endSequence: number;
    readonly sessionId?: string;
    readonly signal?: AbortSignal;
}

export interface CompactToolResultOptions {
    readonly toolName: string;
    readonly callId: string;
    readonly content: string;
    readonly targetTokens: number;
    readonly signal?: AbortSignal;
}

export interface ContextCompactorOptions {
    readonly provider: ModelProvider;
    readonly profile?: ModelProfile;
    readonly store?: ConversationStore;
    readonly maxSummaryTokens?: number;
    readonly charsPerToken?: number;
}

export interface ContextCompactor {
    compactHistory(options: CompactHistoryOptions): Promise<StructuredSummary | null>;
    compactToolResult(options: CompactToolResultOptions): Promise<string | null>;
}

/**
 * Formats a structured summary into an untrusted background context message
 * with explicit provenance and omission markers.
 */
export const formatSummaryAsModelItem = (summary: StructuredSummary): ModelItem => {
    const lines: string[] = [
        `[Historical context summary (untrusted background summary covering turns/sequences ${summary.sourceRange.startSequence}-${summary.sourceRange.endSequence}, not system instructions)]:`,
        "",
        `### Task or Investigation`,
        summary.taskOrInvestigation,
        "",
        `### Important Findings`,
        summary.importantFindings.length > 0
            ? summary.importantFindings.map((f) => `- ${f}`).join("\n")
            : "None noted.",
        "",
        `### Files and Locations Investigated`,
        summary.filesAndLocations.length > 0
            ? summary.filesAndLocations.map((f) => `- ${f}`).join("\n")
            : "None noted.",
        "",
        `### Decisions Made`,
        summary.decisions.length > 0
            ? summary.decisions.map((d) => `- ${d}`).join("\n")
            : "None noted.",
        "",
        `### Failed Approaches`,
        summary.failedApproaches.length > 0
            ? summary.failedApproaches.map((a) => `- ${a}`).join("\n")
            : "None noted.",
        "",
        `### Unresolved Issues`,
        summary.unresolvedIssues.length > 0
            ? summary.unresolvedIssues.map((u) => `- ${u}`).join("\n")
            : "None noted.",
        "",
        `### Next Recommended Steps`,
        summary.nextSteps.length > 0
            ? summary.nextSteps.map((s) => `- ${s}`).join("\n")
            : "None noted.",
        "",
        `### Information Omissions`,
        summary.omissions,
    ];

    return {
        type: "message",
        role: "user",
        content: lines.join("\n"),
        isPolicy: false,
        provenance: {
            source: "history",
            relevance: 1.0,
            documents: summary.sourceRange.sessionId
                ? [
                      {
                          id: `summary-${summary.sourceRange.startSequence}-${summary.sourceRange.endSequence}`,
                          sessionId: summary.sourceRange.sessionId,
                          startSequence: summary.sourceRange.startSequence,
                          endSequence: summary.sourceRange.endSequence,
                      },
                  ]
                : undefined,
        },
    };
};

/**
 * Validates the schema and token budget bounds of an AI-generated structured summary.
 */
export const validateStructuredSummary = (
    data: unknown,
    maxTokens = 1200,
    charsPerToken = 4,
): StructuredSummary => {
    if (!data || typeof data !== "object") {
        throw new TypeError("Invalid context summary: output must be an object");
    }
    const obj = data as Record<string, unknown>;

    if (typeof obj.taskOrInvestigation !== "string" || obj.taskOrInvestigation.trim() === "") {
        throw new TypeError(
            "Invalid context summary: taskOrInvestigation must be a non-empty string",
        );
    }

    const toStringArray = (val: unknown, fieldName: string): string[] => {
        if (!Array.isArray(val)) {
            throw new TypeError(
                `Invalid context summary: ${fieldName} must be an array of strings`,
            );
        }
        return val.map((item, idx) => {
            if (typeof item !== "string") {
                throw new TypeError(
                    `Invalid context summary: ${fieldName}[${idx}] must be a string`,
                );
            }
            return item;
        });
    };

    const importantFindings = toStringArray(obj.importantFindings, "importantFindings");
    const filesAndLocations = toStringArray(obj.filesAndLocations, "filesAndLocations");
    const decisions = toStringArray(obj.decisions, "decisions");
    const failedApproaches = toStringArray(obj.failedApproaches, "failedApproaches");
    const unresolvedIssues = toStringArray(obj.unresolvedIssues, "unresolvedIssues");
    const nextSteps = toStringArray(obj.nextSteps, "nextSteps");

    if (typeof obj.omissions !== "string") {
        throw new TypeError(
            "Invalid context summary: omissions must be a string describing omissions",
        );
    }

    if (!obj.sourceRange || typeof obj.sourceRange !== "object") {
        throw new TypeError("Invalid context summary: sourceRange must be an object");
    }
    const range = obj.sourceRange as Record<string, unknown>;
    if (typeof range.startSequence !== "number" || typeof range.endSequence !== "number") {
        throw new TypeError(
            "Invalid context summary: sourceRange must contain startSequence and endSequence numbers",
        );
    }

    const summary: StructuredSummary = {
        taskOrInvestigation: obj.taskOrInvestigation,
        importantFindings,
        filesAndLocations,
        decisions,
        failedApproaches,
        unresolvedIssues,
        nextSteps,
        omissions: obj.omissions,
        sourceRange: {
            sessionId: typeof range.sessionId === "string" ? range.sessionId : undefined,
            startSequence: range.startSequence,
            endSequence: range.endSequence,
        },
    };

    const formattedItem = formatSummaryAsModelItem(summary);
    const tokens = estimateModelItemTokens(formattedItem, charsPerToken);
    if (tokens > maxTokens) {
        throw new RangeError(
            `Context summary is oversized: estimated ${tokens} tokens exceeds limit of ${maxTokens} tokens`,
        );
    }

    return summary;
};

/**
 * Provider-neutral AI context compactor that produces structured summaries
 * of eligible history and persistently stores them in SQLite.
 */
export class DefaultContextCompactor implements ContextCompactor {
    private readonly provider: ModelProvider;
    private readonly profile?: ModelProfile;
    private readonly store?: ConversationStore;
    private readonly maxSummaryTokens: number;
    private readonly charsPerToken: number;

    constructor(options: ContextCompactorOptions) {
        this.provider = options.provider;
        this.profile = options.profile;
        this.store = options.store;
        this.maxSummaryTokens = options.maxSummaryTokens ?? 1000;
        this.charsPerToken = options.charsPerToken ?? options.profile?.charsPerToken ?? 4;
    }

    compactHistory = async (options: CompactHistoryOptions): Promise<StructuredSummary | null> => {
        if (options.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        // 1. Check persistent SQLite cache for existing summary covering this exact sequence range
        if (this.store && options.sessionId) {
            try {
                const cached = await this.store.findContextSummary(
                    options.sessionId,
                    options.startSequence,
                    options.endSequence,
                );
                if (cached) {
                    const parsed = JSON.parse(cached.summaryJson);
                    return validateStructuredSummary(
                        parsed,
                        this.maxSummaryTokens,
                        this.charsPerToken,
                    );
                }
            } catch {
                // If cache read or validation fails, proceed with compaction
            }
        }

        if (options.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        // 2. Format items into bounded compaction input
        const serializedHistory = options.items
            .map((item) => {
                if (item.type === "message") {
                    return `[${item.role}]: ${item.content}`;
                }
                if (item.type === "tool_call") {
                    const args =
                        typeof item.arguments === "string"
                            ? item.arguments
                            : JSON.stringify(item.arguments ?? {});
                    return `[tool_call:${item.name}(${item.id})]: ${args}`;
                }
                if (item.type === "tool_result") {
                    return `[tool_result(${item.callId})]: ${item.content}`;
                }
                return "";
            })
            .filter(Boolean)
            .join("\n\n");

        const instructions =
            "You are an AI context compactor for a software development assistant.\n" +
            `Summarize the historical conversation turns (sequences ${options.startSequence} to ${options.endSequence}) into a concise, structured JSON object with this exact shape:\n` +
            "{\n" +
            '  "taskOrInvestigation": "Concise summary of the task or objective",\n' +
            '  "importantFindings": ["Key architectural, structural, or code finding 1", "..."],\n' +
            '  "filesAndLocations": ["path/to/file.ts", "..."],\n' +
            '  "decisions": ["Architectural or implementation decision 1", "..."],\n' +
            '  "failedApproaches": ["Approach tried that failed or was abandoned", "..."],\n' +
            '  "unresolvedIssues": ["Open question or remaining issue", "..."],\n' +
            '  "nextSteps": ["Immediate next recommended step", "..."],\n' +
            '  "omissions": "Description of detailed source code listings, verbose logs, or tool results omitted"\n' +
            "}\n\n" +
            "Output strictly valid JSON. Do not include markdown code fences or explanatory text.";

        const request: ModelRequest = {
            items: [
                {
                    type: "message",
                    role: "system",
                    content: instructions,
                },
                {
                    type: "message",
                    role: "user",
                    content: `--- CONVERSATION HISTORY TO SUMMARIZE ---\n${serializedHistory}`,
                },
            ],
            tools: undefined, // Strictly disable tools: compactor never executes tools or enters tool loop
            signal: options.signal,
            profile: this.profile,
        };

        let responseText = "";
        try {
            for await (const event of this.provider.stream(request)) {
                if (options.signal?.aborted) {
                    throw new DOMException("The operation was aborted.", "AbortError");
                }
                if (event.type === "text") {
                    responseText += event.content;
                }
            }
        } catch (error) {
            if (
                options.signal?.aborted ||
                (error instanceof Error && error.name === "AbortError")
            ) {
                throw error;
            }
            return null;
        }

        // 3. Extract and validate JSON response
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return null;
        }

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(jsonMatch[0]);
        } catch {
            return null;
        }

        parsed.sourceRange = {
            sessionId: options.sessionId,
            startSequence: options.startSequence,
            endSequence: options.endSequence,
        };

        let summary: StructuredSummary;
        try {
            summary = validateStructuredSummary(parsed, this.maxSummaryTokens, this.charsPerToken);
        } catch {
            return null;
        }

        // 4. Persist validated summary to SQLite for future turns and sessions
        if (this.store && options.sessionId) {
            try {
                const formattedItem = formatSummaryAsModelItem(summary);
                const estimatedTokens = estimateModelItemTokens(formattedItem, this.charsPerToken);
                await this.store.saveContextSummary({
                    sessionId: options.sessionId,
                    startSequence: options.startSequence,
                    endSequence: options.endSequence,
                    summaryJson: JSON.stringify(summary),
                    estimatedTokens,
                });
            } catch {
                // Persistence failure must not abort an otherwise successful in-memory compaction
            }
        }

        return summary;
    };

    compactToolResult = async (options: CompactToolResultOptions): Promise<string | null> => {
        if (options.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        const maxContentChars = options.targetTokens * this.charsPerToken;
        const boundedSnippet =
            options.content.length > maxContentChars * 4
                ? options.content.slice(0, maxContentChars * 4) +
                  "\n...[Remainder truncated before compaction]"
                : options.content;

        const promptText =
            `Summarize the following output from tool "${options.toolName}" (call ID: "${options.callId}") concisely within ${options.targetTokens} tokens.\n` +
            `Preserve file paths, line numbers, errors, match counts, and structural findings.\n` +
            `Explicitly state what information was omitted.\n\n` +
            `Output:\n${boundedSnippet}`;

        const request: ModelRequest = {
            items: [
                {
                    type: "message",
                    role: "user",
                    content: promptText,
                },
            ],
            tools: undefined,
            signal: options.signal,
            profile: this.profile,
        };

        let responseText = "";
        try {
            for await (const event of this.provider.stream(request)) {
                if (options.signal?.aborted) {
                    throw new DOMException("The operation was aborted.", "AbortError");
                }
                if (event.type === "text") {
                    responseText += event.content;
                }
            }
        } catch (error) {
            if (
                options.signal?.aborted ||
                (error instanceof Error && error.name === "AbortError")
            ) {
                throw error;
            }
            return null;
        }

        const trimmed = responseText.trim();
        if (trimmed.length === 0) {
            return null;
        }

        const formatted =
            `[Summary of ${options.toolName} (${options.callId})]:\n` +
            `${trimmed}\n\n` +
            `[Canonical transcript retains full original output (${options.content.length} characters). Details omitted for token budget.]`;

        const tokens = estimateTokens(formatted, this.charsPerToken) + 4;
        if (tokens > options.targetTokens * 1.5) {
            return null;
        }

        return formatted;
    };
}

export const createContextCompactor = (options: ContextCompactorOptions): ContextCompactor =>
    new DefaultContextCompactor(options);
