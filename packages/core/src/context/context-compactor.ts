import type { ModelItem, ModelProfile, ModelProvider, ModelRequest } from "@akkco/models";
import type { ConversationStore } from "@akkco/retrieval";
import { ensureBoundedProvider } from "./bounded-model-provider.js";
import { calculateMaxInputTokens } from "./budget.js";
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
    readonly turns?: readonly {
        readonly startSequence: number;
        readonly endSequence: number;
        readonly items: readonly ModelItem[];
    }[];
    readonly onProgress?: CompactionProgressListener;
}

export interface CompactToolResultOptions {
    readonly toolName: string;
    readonly callId: string;
    readonly content: string;
    readonly targetTokens: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: CompactionProgressListener;
}

export type CompactionProgressEvent =
    | { readonly type: "start"; readonly scope: "history" }
    | { readonly type: "start"; readonly scope: "tool"; readonly toolName: string }
    | { readonly type: "success"; readonly scope: "history" }
    | { readonly type: "success"; readonly scope: "tool"; readonly toolName: string }
    | { readonly type: "fallback"; readonly scope: "history" }
    | { readonly type: "fallback"; readonly scope: "tool"; readonly toolName: string }
    | { readonly type: "cancel"; readonly scope: "history" | "tool"; readonly toolName?: string };

export type CompactionProgressListener = (event: CompactionProgressEvent) => void;

export interface ContextCompactorOptions {
    readonly provider: ModelProvider;
    readonly profile?: ModelProfile;
    readonly store?: ConversationStore;
    readonly maxSummaryTokens?: number;
    readonly charsPerToken?: number;
    readonly onProgress?: CompactionProgressListener;
}

export interface ContextCompactor {
    compactHistory(options: CompactHistoryOptions): Promise<StructuredSummary | null>;
    compactToolResult(options: CompactToolResultOptions): Promise<string | null>;
    onProgress?(listener: CompactionProgressListener): () => void;
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
const MAX_COMPACTION_CHUNKS = 16;
const MIN_PRACTICAL_CHUNK_TOKENS = 20;

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
    private readonly progressListeners = new Set<CompactionProgressListener>();

    constructor(options: ContextCompactorOptions) {
        this.profile = options.profile;
        this.provider = ensureBoundedProvider(options.provider, { profile: options.profile });
        this.store = options.store;
        this.maxSummaryTokens = options.maxSummaryTokens ?? 1000;
        this.charsPerToken = options.charsPerToken ?? options.profile?.charsPerToken ?? 4;
        if (options.onProgress) {
            this.progressListeners.add(options.onProgress);
        }
    }

    onProgress = (listener: CompactionProgressListener): (() => void) => {
        this.progressListeners.add(listener);
        return () => {
            this.progressListeners.delete(listener);
        };
    };

    private emitProgress = (
        perCallListener: CompactionProgressListener | undefined,
        event: CompactionProgressEvent,
    ): void => {
        try {
            perCallListener?.(event);
        } catch {}
        for (const listener of this.progressListeners) {
            try {
                listener(event);
            } catch {}
        }
    };

    private executeCompactorPrompt = async (
        items: ModelItem[],
        signal?: AbortSignal,
    ): Promise<string | null> => {
        if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        const request: ModelRequest = {
            items,
            tools: undefined, // Compactor strictly never passes tools or executes tools
            signal,
            profile: this.profile,
        };

        let responseText = "";
        try {
            for await (const event of this.provider.stream(request)) {
                if (signal?.aborted) {
                    throw new DOMException("The operation was aborted.", "AbortError");
                }
                if (event.type === "text") {
                    responseText += event.content;
                }
            }
        } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
                throw error;
            }
            return null;
        }

        return responseText;
    };

    private serializeHistoryItems = (items: readonly ModelItem[]): string =>
        items
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

    private chunkHistoryItems = (
        items: readonly ModelItem[],
        maxTokensPerChunk: number,
    ): ModelItem[][] => {
        if (items.length === 0) {
            return [];
        }

        const maxChunkChars = Math.max(1, maxTokensPerChunk * this.charsPerToken);
        const splitItems: ModelItem[] = [];

        for (const item of items) {
            const itemTokens = estimateModelItemTokens(item, this.charsPerToken);
            if (itemTokens > maxTokensPerChunk) {
                // Slice oversized single item content into chunks that fit within maxTokensPerChunk
                if (item.type === "message") {
                    for (let i = 0; i < item.content.length; i += maxChunkChars) {
                        splitItems.push({
                            ...item,
                            content: item.content.slice(i, i + maxChunkChars),
                        });
                    }
                } else if (item.type === "tool_result") {
                    for (let i = 0; i < item.content.length; i += maxChunkChars) {
                        splitItems.push({
                            ...item,
                            content: item.content.slice(i, i + maxChunkChars),
                        });
                    }
                } else {
                    splitItems.push(item);
                }
            } else {
                splitItems.push(item);
            }
        }

        const chunks: ModelItem[][] = [];
        let currentChunk: ModelItem[] = [];
        let currentChunkTokens = 0;

        for (const item of splitItems) {
            const itemTokens = estimateModelItemTokens(item, this.charsPerToken);
            if (currentChunk.length > 0 && currentChunkTokens + itemTokens > maxTokensPerChunk) {
                chunks.push(currentChunk);
                currentChunk = [item];
                currentChunkTokens = itemTokens;
            } else {
                currentChunk.push(item);
                currentChunkTokens += itemTokens;
            }
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }

        return chunks;
    };

    compactHistory = async (options: CompactHistoryOptions): Promise<StructuredSummary | null> => {
        if (options.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        // 1. Check persistent SQLite cache for existing summary covering this range or a reusable prefix
        let previousSummary: StructuredSummary | null = null;
        let candidateStartSequence = options.startSequence;

        if (this.store && options.sessionId) {
            try {
                const latestCached = await this.store.findLatestContextSummary(
                    options.sessionId,
                    options.startSequence,
                    options.endSequence,
                );
                if (latestCached) {
                    const parsed = JSON.parse(latestCached.summaryJson);
                    const validated = validateStructuredSummary(
                        parsed,
                        this.maxSummaryTokens,
                        this.charsPerToken,
                    );
                    if (
                        validated.sourceRange.startSequence === options.startSequence &&
                        validated.sourceRange.endSequence <= options.endSequence
                    ) {
                        if (latestCached.endSequence === options.endSequence) {
                            return validated;
                        }
                        if (latestCached.endSequence < options.endSequence) {
                            previousSummary = validated;
                            candidateStartSequence = latestCached.endSequence + 1;
                        }
                    }
                }
            } catch {
                // If cache read or validation fails, proceed with compaction
            }
        }

        if (options.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        // 2. Identify items to summarize
        let itemsToSummarize: readonly ModelItem[] = options.items;
        if (previousSummary) {
            if (options.turns && options.turns.length > 0) {
                itemsToSummarize = options.turns
                    .filter((t) => t.startSequence >= candidateStartSequence)
                    .flatMap((t) => t.items);
            } else if (options.items.length === options.endSequence - options.startSequence + 1) {
                itemsToSummarize = options.items.slice(
                    candidateStartSequence - options.startSequence,
                );
            }
        }

        const compactorCapacity = this.profile ? calculateMaxInputTokens(this.profile) : 8192;

        const instructions =
            `Summarize conversation history (sequences ${options.startSequence}-${options.endSequence}) into JSON:\n` +
            `{"taskOrInvestigation":"","importantFindings":[],"filesAndLocations":[],"decisions":[],"failedApproaches":[],"unresolvedIssues":[],"nextSteps":[],"omissions":""}\n` +
            `Output strictly valid JSON only.`;

        const instructionsTokens = estimateTokens(instructions, this.charsPerToken) + 4;

        const previousSummaryFramingTemplate =
            `--- PREVIOUS VALIDATED CONTEXT SUMMARY (sequences ${options.startSequence} to ${options.endSequence}) ---\n` +
            `\n\n--- NEW CONVERSATION TURNS TO INCORPORATE ---\n`;
        const framingOverheadTokens =
            estimateTokens(previousSummaryFramingTemplate, this.charsPerToken) + 8;

        const maxIntermediateSummaryTokens = Math.min(
            this.maxSummaryTokens,
            this.profile?.maxOutputTokens ?? this.maxSummaryTokens,
            Math.floor(compactorCapacity * 0.45),
        );
        const reservedForSummary =
            (previousSummary
                ? estimateTokens(JSON.stringify(previousSummary), this.charsPerToken)
                : maxIntermediateSummaryTokens) + framingOverheadTokens;

        const availableContentTokens =
            compactorCapacity - instructionsTokens - reservedForSummary - 8;
        if (availableContentTokens < MIN_PRACTICAL_CHUNK_TOKENS) {
            return null;
        }

        const chunks = this.chunkHistoryItems(itemsToSummarize, availableContentTokens);

        let currentSummary = previousSummary;

        if (chunks.length === 0 && currentSummary) {
            return currentSummary;
        }
        if (chunks.length === 0) {
            return null;
        }
        if (chunks.length > MAX_COMPACTION_CHUNKS) {
            return null;
        }

        this.emitProgress(options.onProgress, { type: "start", scope: "history" });

        try {
            for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
                if (options.signal?.aborted) {
                    this.emitProgress(options.onProgress, { type: "cancel", scope: "history" });
                    throw new DOMException("The operation was aborted.", "AbortError");
                }

                const chunkItems = chunks[chunkIdx];
                const serializedChunk = this.serializeHistoryItems(chunkItems);

                let userContent = "";
                let promptFraming = "";
                if (currentSummary) {
                    promptFraming =
                        `--- PREVIOUS VALIDATED CONTEXT SUMMARY (sequences ${currentSummary.sourceRange.startSequence} to ${currentSummary.sourceRange.endSequence}) ---\n` +
                        JSON.stringify(currentSummary) +
                        `\n\n--- NEW CONVERSATION TURNS TO INCORPORATE ---\n`;
                    userContent = `${promptFraming}${serializedChunk}`;
                } else {
                    promptFraming = `--- CONVERSATION HISTORY TO SUMMARIZE ---\n`;
                    userContent = `${promptFraming}${serializedChunk}`;
                }

                const systemItem: ModelItem = {
                    type: "message",
                    role: "system",
                    content: instructions,
                };
                const userItem: ModelItem = { type: "message", role: "user", content: userContent };
                const totalTokens =
                    estimateModelItemTokens(systemItem, this.charsPerToken) +
                    estimateModelItemTokens(userItem, this.charsPerToken);

                if (totalTokens > compactorCapacity) {
                    this.emitProgress(options.onProgress, { type: "fallback", scope: "history" });
                    return null;
                }

                const responseText = await this.executeCompactorPrompt(
                    [
                        { type: "message", role: "system", content: instructions },
                        { type: "message", role: "user", content: userContent },
                    ],
                    options.signal,
                );

                if (!responseText) {
                    this.emitProgress(options.onProgress, { type: "fallback", scope: "history" });
                    return null;
                }

                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                if (!jsonMatch) {
                    this.emitProgress(options.onProgress, { type: "fallback", scope: "history" });
                    return null;
                }

                let parsed: Record<string, unknown>;
                try {
                    parsed = JSON.parse(jsonMatch[0]);
                } catch {
                    this.emitProgress(options.onProgress, { type: "fallback", scope: "history" });
                    return null;
                }

                parsed.sourceRange = {
                    sessionId: options.sessionId,
                    startSequence: options.startSequence,
                    endSequence:
                        chunkIdx === chunks.length - 1
                            ? options.endSequence
                            : candidateStartSequence + chunkIdx,
                };

                let validatedChunkSummary: StructuredSummary;
                try {
                    validatedChunkSummary = validateStructuredSummary(
                        parsed,
                        this.maxSummaryTokens,
                        this.charsPerToken,
                    );
                } catch {
                    this.emitProgress(options.onProgress, { type: "fallback", scope: "history" });
                    return null;
                }

                currentSummary = validatedChunkSummary;
            }

            if (!currentSummary) {
                this.emitProgress(options.onProgress, { type: "fallback", scope: "history" });
                return null;
            }

            const finalSummary: StructuredSummary = {
                ...currentSummary,
                sourceRange: {
                    sessionId: options.sessionId,
                    startSequence: options.startSequence,
                    endSequence: options.endSequence,
                },
            };

            // Persist validated summary to SQLite (and automatically prune superseded prefix summaries)
            if (this.store && options.sessionId) {
                try {
                    const formattedItem = formatSummaryAsModelItem(finalSummary);
                    const estimatedTokens = estimateModelItemTokens(
                        formattedItem,
                        this.charsPerToken,
                    );
                    await this.store.saveContextSummary({
                        sessionId: options.sessionId,
                        startSequence: options.startSequence,
                        endSequence: options.endSequence,
                        summaryJson: JSON.stringify(finalSummary),
                        estimatedTokens,
                    });
                } catch {
                    // Persistence failure must not abort an otherwise successful in-memory compaction
                }
            }

            this.emitProgress(options.onProgress, { type: "success", scope: "history" });
            return finalSummary;
        } catch (error) {
            if (
                options.signal?.aborted ||
                (error instanceof Error && error.name === "AbortError")
            ) {
                this.emitProgress(options.onProgress, { type: "cancel", scope: "history" });
                throw error;
            }
            this.emitProgress(options.onProgress, { type: "fallback", scope: "history" });
            return null;
        }
    };

    compactToolResult = async (options: CompactToolResultOptions): Promise<string | null> => {
        if (options.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        const makeFormatted = (body: string) =>
            `[Summary of ${options.toolName} (${options.callId})]:\n` +
            `${body}\n\n` +
            `[Canonical transcript retains full original output (${options.content.length} characters). Details omitted for token budget.]`;

        const framingOverhead = estimateTokens(makeFormatted(""), this.charsPerToken) + 4;
        const targetBodyTokens = options.targetTokens - framingOverhead;

        if (targetBodyTokens < 8) {
            return null;
        }

        const compactorCapacity = this.profile ? calculateMaxInputTokens(this.profile) : 8192;

        const singlePromptIntro =
            `Summarize the following output from tool "${options.toolName}" (call ID: "${options.callId}") concisely within ${targetBodyTokens} tokens.\n` +
            `Preserve all key metadata: tool name, call ID, file paths, line numbers, exit codes, errors, status, and structural findings.\n` +
            `Explicitly include an omission note stating what information, verbose logs, or details were omitted.\n\n` +
            `Output:\n`;

        const singlePromptFramingTokens =
            estimateTokens(singlePromptIntro, this.charsPerToken) + 16;
        const availableSingleContentTokens = compactorCapacity - singlePromptFramingTokens;

        if (availableSingleContentTokens < MIN_PRACTICAL_CHUNK_TOKENS) {
            return null;
        }

        const contentTokens = estimateTokens(options.content, this.charsPerToken);

        this.emitProgress(options.onProgress, {
            type: "start",
            scope: "tool",
            toolName: options.toolName,
        });

        try {
            let summaryBody: string | null = null;

            if (contentTokens <= availableSingleContentTokens) {
                const promptText = `${singlePromptIntro}${options.content}`;
                const response = await this.executeCompactorPrompt(
                    [{ type: "message", role: "user", content: promptText }],
                    options.signal,
                );

                if (!response) {
                    this.emitProgress(options.onProgress, {
                        type: "fallback",
                        scope: "tool",
                        toolName: options.toolName,
                    });
                    return null;
                }
                summaryBody = response.trim();
            } else {
                const chunkPromptIntro = (idx: number, total: number, target: number) =>
                    `Extract key findings, file paths, line numbers, error messages, and omissions from part ${idx}/${total} of tool "${options.toolName}" output within ${target} tokens:\n\n`;

                const maxChunkPromptFraming =
                    estimateTokens(chunkPromptIntro(99, 99, targetBodyTokens), this.charsPerToken) +
                    16;
                const availableToolChunkTokens = compactorCapacity - maxChunkPromptFraming;

                if (availableToolChunkTokens < MIN_PRACTICAL_CHUNK_TOKENS) {
                    this.emitProgress(options.onProgress, {
                        type: "fallback",
                        scope: "tool",
                        toolName: options.toolName,
                    });
                    return null;
                }

                const maxLineChars = Math.max(1, availableToolChunkTokens * this.charsPerToken);
                const lines = options.content.split("\n");
                const lineSlices: string[] = [];

                for (const line of lines) {
                    const lineTokens = estimateTokens(line, this.charsPerToken) + 1;
                    if (lineTokens > availableToolChunkTokens) {
                        for (let i = 0; i < line.length; i += maxLineChars) {
                            lineSlices.push(line.slice(i, i + maxLineChars));
                        }
                    } else {
                        lineSlices.push(line);
                    }
                }

                const chunks: string[] = [];
                let currentLines: string[] = [];
                let currentTokens = 0;

                for (const slice of lineSlices) {
                    const sliceTokens = estimateTokens(slice, this.charsPerToken) + 1;
                    if (
                        currentLines.length > 0 &&
                        currentTokens + sliceTokens > availableToolChunkTokens
                    ) {
                        chunks.push(currentLines.join("\n"));
                        currentLines = [slice];
                        currentTokens = sliceTokens;
                    } else {
                        currentLines.push(slice);
                        currentTokens += sliceTokens;
                    }
                }
                if (currentLines.length > 0) {
                    chunks.push(currentLines.join("\n"));
                }

                if (chunks.length > MAX_COMPACTION_CHUNKS) {
                    this.emitProgress(options.onProgress, {
                        type: "fallback",
                        scope: "tool",
                        toolName: options.toolName,
                    });
                    return null;
                }

                const partialSummaries: string[] = [];
                for (let i = 0; i < chunks.length; i++) {
                    if (options.signal?.aborted) {
                        this.emitProgress(options.onProgress, {
                            type: "cancel",
                            scope: "tool",
                            toolName: options.toolName,
                        });
                        throw new DOMException("The operation was aborted.", "AbortError");
                    }
                    const targetTokensForPart = Math.max(
                        10,
                        Math.floor(targetBodyTokens / chunks.length),
                    );
                    const chunkPrompt = `${chunkPromptIntro(i + 1, chunks.length, targetTokensForPart)}${chunks[i]}`;

                    const partial = await this.executeCompactorPrompt(
                        [{ type: "message", role: "user", content: chunkPrompt }],
                        options.signal,
                    );

                    if (!partial) {
                        this.emitProgress(options.onProgress, {
                            type: "fallback",
                            scope: "tool",
                            toolName: options.toolName,
                        });
                        return null;
                    }
                    partialSummaries.push(partial.trim());
                }

                const mergePrompt =
                    `Consolidate the following partial summaries for tool "${options.toolName}" (call ID: "${options.callId}") into a single concise summary within ${targetBodyTokens} tokens.\n` +
                    `Preserve file paths, line numbers, error codes, and explicit omissions.\n\n` +
                    partialSummaries.join("\n\n");

                if (estimateTokens(mergePrompt, this.charsPerToken) + 16 > compactorCapacity) {
                    this.emitProgress(options.onProgress, {
                        type: "fallback",
                        scope: "tool",
                        toolName: options.toolName,
                    });
                    return null;
                }

                const merged = await this.executeCompactorPrompt(
                    [{ type: "message", role: "user", content: mergePrompt }],
                    options.signal,
                );

                if (!merged) {
                    this.emitProgress(options.onProgress, {
                        type: "fallback",
                        scope: "tool",
                        toolName: options.toolName,
                    });
                    return null;
                }
                summaryBody = merged.trim();
            }

            if (!summaryBody || summaryBody.length === 0) {
                this.emitProgress(options.onProgress, {
                    type: "fallback",
                    scope: "tool",
                    toolName: options.toolName,
                });
                return null;
            }

            const formatted = makeFormatted(summaryBody);
            const totalEstimated = estimateTokens(formatted, this.charsPerToken) + 4;

            if (totalEstimated > options.targetTokens) {
                this.emitProgress(options.onProgress, {
                    type: "fallback",
                    scope: "tool",
                    toolName: options.toolName,
                });
                return null;
            }

            this.emitProgress(options.onProgress, {
                type: "success",
                scope: "tool",
                toolName: options.toolName,
            });
            return formatted;
        } catch (error) {
            if (
                options.signal?.aborted ||
                (error instanceof Error && error.name === "AbortError")
            ) {
                this.emitProgress(options.onProgress, {
                    type: "cancel",
                    scope: "tool",
                    toolName: options.toolName,
                });
                throw error;
            }
            this.emitProgress(options.onProgress, {
                type: "fallback",
                scope: "tool",
                toolName: options.toolName,
            });
            return null;
        }
    };
}

export const createContextCompactor = (options: ContextCompactorOptions): ContextCompactor =>
    new DefaultContextCompactor(options);
