import type { ModelProfile, ModelProvider, ModelRequest } from "@akkco/models";
import { ensureBoundedProvider } from "../../context/bounded-model-provider.js";
import { calculateMaxInputTokens, type ContextBudget } from "../../context/budget.js";
import { estimateTokens } from "../../context/token-estimator.js";
import {
    type MilestoneExecutionStatus,
    type ToolMilestone,
    validateToolMilestone,
} from "./types.js";

export interface ProcessToolMilestoneOptions {
    readonly parentGoal: string;
    readonly parentGoalId: string;
    readonly callId: string;
    readonly toolName: string;
    readonly arguments: unknown;
    readonly rawResult?: string;
    readonly error?: string;
    readonly executionStatus: MilestoneExecutionStatus;
    readonly durationMs?: number;
    readonly signal?: AbortSignal;
}

export interface MilestoneProcessorOptions {
    readonly provider?: ModelProvider;
    readonly profile?: ModelProfile;
    readonly budget?: ContextBudget;
    readonly maxMilestoneTokens?: number;
    readonly deterministicThresholdTokens?: number;
    readonly charsPerToken?: number;
}

export interface MilestoneProcessor {
    processToolExecution(options: ProcessToolMilestoneOptions): Promise<ToolMilestone>;
}

const formatMilestoneEstimatePayload = (
    summary: string,
    findings: readonly string[],
    sourceLocations?: readonly string[],
    unresolvedQuestions?: readonly string[],
    omissions?: string,
): string => {
    return [
        summary,
        ...findings,
        ...(sourceLocations ?? []),
        ...(unresolvedQuestions ?? []),
        omissions ?? "",
    ].join("\n");
};

/**
 * Extracts and validates tool execution evidence into an independent, bounded ToolMilestone.
 * Small outputs are processed deterministically without inference. Dense outputs use
 * a bounded AI summarization pass that validates source metadata.
 */
export class DefaultMilestoneProcessor implements MilestoneProcessor {
    private readonly provider?: ModelProvider;
    private readonly profile?: ModelProfile;
    private readonly budget?: ContextBudget;
    private readonly maxMilestoneTokens: number;
    private readonly deterministicThresholdTokens: number;
    private readonly charsPerToken: number;

    constructor(options?: MilestoneProcessorOptions) {
        this.profile = options?.profile;
        this.budget = options?.budget;
        this.maxMilestoneTokens = options?.maxMilestoneTokens ?? 600;
        this.deterministicThresholdTokens = options?.deterministicThresholdTokens ?? 250;
        this.charsPerToken = options?.charsPerToken ?? options?.profile?.charsPerToken ?? 4;

        if (options?.provider) {
            this.provider = ensureBoundedProvider(options.provider, {
                profile: options.profile,
                budget: options.budget,
            });
        }
    }

    processToolExecution = async (options: ProcessToolMilestoneOptions): Promise<ToolMilestone> => {
        if (options.signal?.aborted) {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            throw err;
        }

        const milestoneId = `milestone-${options.callId}`;
        const evidenceRef = `call:${options.callId}`;

        // 1. Handle non-completed executions (failed or cancelled) deterministically
        if (options.executionStatus !== "completed") {
            const summary = options.error
                ? `Tool execution failed: ${options.error}`
                : `Tool execution was ${options.executionStatus}`;
            const unresolved = options.error
                ? [`Why did ${options.toolName} fail: ${options.error}`]
                : [`Tool execution was ${options.executionStatus}`];
            const estTokens = estimateTokens(
                formatMilestoneEstimatePayload(summary, [], [], unresolved),
                this.charsPerToken,
            );

            return validateToolMilestone({
                id: milestoneId,
                parentGoalId: options.parentGoalId,
                callId: options.callId,
                toolName: options.toolName,
                arguments: options.arguments,
                executionStatus: options.executionStatus,
                processingStatus: "completed",
                error: options.error,
                durationMs: options.durationMs,
                summary,
                findings: [],
                sourceLocations: [],
                relationships: [],
                unresolvedQuestions: unresolved,
                omissions: undefined,
                evidenceRefs: [evidenceRef],
                estimatedTokens: estTokens,
            });
        }

        const rawResult = options.rawResult ?? "";

        // 2. Handle empty results
        if (rawResult.trim().length === 0) {
            const summary = `Tool ${options.toolName} completed with empty output.`;
            const findings = ["Empty output returned."];
            const estTokens = estimateTokens(
                formatMilestoneEstimatePayload(summary, findings),
                this.charsPerToken,
            );

            return validateToolMilestone({
                id: milestoneId,
                parentGoalId: options.parentGoalId,
                callId: options.callId,
                toolName: options.toolName,
                arguments: options.arguments,
                executionStatus: "completed",
                processingStatus: "completed",
                durationMs: options.durationMs,
                summary,
                findings,
                sourceLocations: [],
                relationships: [],
                unresolvedQuestions: [],
                omissions: undefined,
                evidenceRefs: [evidenceRef],
                estimatedTokens: estTokens,
            });
        }

        const resultTokens = estimateTokens(rawResult, this.charsPerToken);

        // 3. Short outputs: Deterministic extraction without LLM inference
        if (resultTokens <= this.deterministicThresholdTokens) {
            return this.extractDeterministicMilestone(options, rawResult, milestoneId, evidenceRef);
        }

        // 4. Large outputs: Bounded AI summarization if provider is available
        if (this.provider) {
            try {
                const aiMilestone = await this.executeAiSummarization(
                    options,
                    rawResult,
                    milestoneId,
                    evidenceRef,
                );
                if (aiMilestone) {
                    return aiMilestone;
                }
            } catch (err) {
                if (
                    options.signal?.aborted ||
                    (err instanceof Error && err.name === "AbortError")
                ) {
                    throw err;
                }
                // AI summarization failed: fall through to explicit fallback with processingStatus: "failed"
            }
        }

        // 5. Fallback for large outputs when summarization is unavailable or failed
        return this.createFallbackMilestone(options, rawResult, milestoneId, evidenceRef);
    };

    /**
     * Deterministically extracts structured evidence from known tools (read_file, list_files, search_text)
     * without spending model tokens or risking hallucination.
     */
    private extractDeterministicMilestone = (
        options: ProcessToolMilestoneOptions,
        rawResult: string,
        milestoneId: string,
        evidenceRef: string,
    ): ToolMilestone => {
        const args = (options.arguments ?? {}) as Record<string, unknown>;

        if (options.toolName === "list_files") {
            const targetPath = typeof args.path === "string" ? args.path : ".";
            const lines = rawResult
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
            const summary = `Listed ${lines.length} entries in "${targetPath}".`;
            const findings = lines.map((line) => line);
            const sourceLocations = lines.map((l) =>
                targetPath === "." ? l : `${targetPath}/${l}`,
            );
            const estTokens = estimateTokens(
                formatMilestoneEstimatePayload(summary, findings, sourceLocations),
                this.charsPerToken,
            );

            return validateToolMilestone({
                id: milestoneId,
                parentGoalId: options.parentGoalId,
                callId: options.callId,
                toolName: options.toolName,
                arguments: options.arguments,
                executionStatus: "completed",
                processingStatus: "completed",
                durationMs: options.durationMs,
                summary,
                findings,
                sourceLocations,
                relationships: [],
                unresolvedQuestions: [],
                omissions: undefined,
                evidenceRefs: [evidenceRef],
                estimatedTokens: estTokens,
            });
        }

        if (options.toolName === "search_text") {
            const query = typeof args.query === "string" ? args.query : "";
            const searchPath = typeof args.path === "string" ? args.path : ".";

            if (rawResult.includes("No matches found") || rawResult.trim() === "") {
                const summary = `No matches found for "${query}" in "${searchPath}".`;
                const findings = ["No occurrences found."];
                const estTokens = estimateTokens(
                    formatMilestoneEstimatePayload(summary, findings),
                    this.charsPerToken,
                );

                return validateToolMilestone({
                    id: milestoneId,
                    parentGoalId: options.parentGoalId,
                    callId: options.callId,
                    toolName: options.toolName,
                    arguments: options.arguments,
                    executionStatus: "completed",
                    processingStatus: "completed",
                    durationMs: options.durationMs,
                    summary,
                    findings,
                    sourceLocations: [],
                    relationships: [],
                    unresolvedQuestions: [],
                    omissions: undefined,
                    evidenceRefs: [evidenceRef],
                    estimatedTokens: estTokens,
                });
            }

            const lines = rawResult
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
            const sourceLocations: string[] = [];
            for (const line of lines) {
                const match = line.match(/^([^:]+:\d+):/);
                if (match) {
                    sourceLocations.push(match[1]);
                } else {
                    const colonIdx = line.indexOf(":");
                    if (colonIdx > 0) {
                        sourceLocations.push(line.slice(0, colonIdx));
                    }
                }
            }

            const uniqueLocations = Array.from(new Set(sourceLocations));
            const summary = `Found ${lines.length} match(es) for "${query}" in ${uniqueLocations.length} file(s).`;
            const estTokens = estimateTokens(
                formatMilestoneEstimatePayload(summary, lines, uniqueLocations),
                this.charsPerToken,
            );

            return validateToolMilestone({
                id: milestoneId,
                parentGoalId: options.parentGoalId,
                callId: options.callId,
                toolName: options.toolName,
                arguments: options.arguments,
                executionStatus: "completed",
                processingStatus: "completed",
                durationMs: options.durationMs,
                summary,
                findings: lines,
                sourceLocations: uniqueLocations,
                relationships: [],
                unresolvedQuestions: [],
                omissions: undefined,
                evidenceRefs: [evidenceRef],
                estimatedTokens: estTokens,
            });
        }

        if (options.toolName === "read_file") {
            const filePath = typeof args.path === "string" ? args.path : "unknown file";
            const lines = rawResult.split("\n");
            const summary = `Read "${filePath}" (${lines.length} lines, ${rawResult.length} characters).`;
            const findings = [rawResult];
            const sourceLocations = [filePath];
            const estTokens = estimateTokens(
                formatMilestoneEstimatePayload(summary, findings, sourceLocations),
                this.charsPerToken,
            );

            return validateToolMilestone({
                id: milestoneId,
                parentGoalId: options.parentGoalId,
                callId: options.callId,
                toolName: options.toolName,
                arguments: options.arguments,
                executionStatus: "completed",
                processingStatus: "completed",
                durationMs: options.durationMs,
                summary,
                findings,
                sourceLocations,
                relationships: [],
                unresolvedQuestions: [],
                omissions: "None. Entire content retained in findings.",
                evidenceRefs: [evidenceRef],
                estimatedTokens: estTokens,
            });
        }

        // Generic tool deterministic extraction
        const summary = `Executed ${options.toolName} successfully.`;
        const findings = [rawResult];
        const estTokens = estimateTokens(
            formatMilestoneEstimatePayload(summary, findings),
            this.charsPerToken,
        );

        return validateToolMilestone({
            id: milestoneId,
            parentGoalId: options.parentGoalId,
            callId: options.callId,
            toolName: options.toolName,
            arguments: options.arguments,
            executionStatus: "completed",
            processingStatus: "completed",
            durationMs: options.durationMs,
            summary,
            findings,
            sourceLocations: [],
            relationships: [],
            unresolvedQuestions: [],
            omissions: undefined,
            evidenceRefs: [evidenceRef],
            estimatedTokens: estTokens,
        });
    };

    /**
     * Executes a bounded, zero-tool AI summarization pass for dense tool output,
     * validating schema and deterministically verifying reported source locations.
     */
    private executeAiSummarization = async (
        options: ProcessToolMilestoneOptions,
        rawResult: string,
        milestoneId: string,
        evidenceRef: string,
    ): Promise<ToolMilestone | null> => {
        if (!this.provider) {
            return null;
        }

        const compactorCapacity = this.profile ? calculateMaxInputTokens(this.profile) : 8192;
        const systemPrompt = [
            "You are an expert technical evidence extraction assistant for software repositories.",
            "Analyze the raw output of a single repository tool execution.",
            "Extract factual evidence strictly relevant to the user's investigation goal.",
            "",
            "CRITICAL CONSTRAINTS:",
            "1. Base all findings strictly on the provided tool output. Do NOT fabricate claims, functions, or line numbers.",
            "2. Include only exact source paths, line numbers, or symbol names that explicitly appear in the tool output or arguments.",
            "3. If no specific source locations exist in the output, leave sourceLocations empty.",
            "4. Formulate specific factual findings. Never say generic phrases like 'This file contains important functions.'",
            "5. Explicitly state what verbose text or details were omitted in the omissions field.",
            "6. You must respond with valid JSON matching this exact structure:",
            '{"summary":"string","findings":["string"],"sourceLocations":["string"],"relationships":["string"],"unresolvedQuestions":["string"],"omissions":"string"}',
        ].join("\n");

        const userContent = [
            `User's Goal: ${options.parentGoal}`,
            `Tool Executed: ${options.toolName}`,
            `Arguments: ${JSON.stringify(options.arguments)}`,
            `Call ID: ${options.callId}`,
            "",
            "--- RAW TOOL OUTPUT ---",
            rawResult,
        ].join("\n");

        const promptTokens =
            estimateTokens(systemPrompt, this.charsPerToken) +
            estimateTokens(userContent, this.charsPerToken);

        if (promptTokens > compactorCapacity) {
            // Cannot safely summarize within capacity: fail closed to explicit fallback
            return null;
        }

        const request: ModelRequest = {
            items: [
                { type: "message", role: "system", content: systemPrompt },
                { type: "message", role: "user", content: userContent },
            ],
            tools: undefined, // Never allow summarizer to invoke tools
            signal: options.signal,
            profile: this.profile,
        };

        let responseText = "";
        for await (const event of this.provider.stream(request)) {
            if (options.signal?.aborted) {
                const err = new Error("This operation was aborted");
                err.name = "AbortError";
                throw err;
            }
            if (event.type === "text") {
                responseText += event.content;
            }
        }

        if (!responseText || responseText.trim().length === 0) {
            return null;
        }

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

        if (typeof parsed.summary !== "string" || !Array.isArray(parsed.findings)) {
            return null;
        }

        // Deterministic Source Verification:
        // Filter out any source locations fabricated by the model that do not appear in the raw tool output or arguments
        const argsStr = JSON.stringify(options.arguments ?? "");
        const verifiedSourceLocations: string[] = [];
        if (Array.isArray(parsed.sourceLocations)) {
            for (const loc of parsed.sourceLocations) {
                if (typeof loc !== "string") continue;
                const pathOnly = loc.split(":")[0].trim();
                if (
                    rawResult.includes(loc) ||
                    rawResult.includes(pathOnly) ||
                    argsStr.includes(pathOnly)
                ) {
                    verifiedSourceLocations.push(loc);
                }
            }
        }

        const summary = parsed.summary.trim();
        const findings = parsed.findings
            .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
            .map((f) => f.trim());
        const relationships = Array.isArray(parsed.relationships)
            ? parsed.relationships.filter((r): r is string => typeof r === "string")
            : [];
        const unresolvedQuestions = Array.isArray(parsed.unresolvedQuestions)
            ? parsed.unresolvedQuestions.filter((q): q is string => typeof q === "string")
            : [];
        const omissions =
            typeof parsed.omissions === "string"
                ? parsed.omissions
                : `Full output retained in transcript evidence (${rawResult.length} characters). Details omitted for token budget.`;

        const estTokens = estimateTokens(
            formatMilestoneEstimatePayload(
                summary,
                findings,
                verifiedSourceLocations,
                unresolvedQuestions,
                omissions,
            ),
            this.charsPerToken,
        );

        return validateToolMilestone({
            id: milestoneId,
            parentGoalId: options.parentGoalId,
            callId: options.callId,
            toolName: options.toolName,
            arguments: options.arguments,
            executionStatus: "completed",
            processingStatus: "completed",
            durationMs: options.durationMs,
            summary,
            findings,
            sourceLocations: verifiedSourceLocations,
            relationships,
            unresolvedQuestions,
            omissions,
            evidenceRefs: [evidenceRef],
            estimatedTokens: estTokens,
        });
    };

    /**
     * Creates an explicit fallback milestone when summarization could not safely complete.
     * Marks processingStatus: "failed" so failures are never silently treated as verified.
     */
    private createFallbackMilestone = (
        options: ProcessToolMilestoneOptions,
        rawResult: string,
        milestoneId: string,
        evidenceRef: string,
    ): ToolMilestone => {
        const summary = `Completed execution of ${options.toolName} (${rawResult.length} chars output).`;
        // Safe bounded head/tail excerpt
        const maxExcerptChars = Math.min(600, rawResult.length);
        const excerpt =
            rawResult.length <= maxExcerptChars
                ? rawResult
                : `${rawResult.slice(0, maxExcerptChars / 2)}\n... [output truncated for milestone] ...\n${rawResult.slice(-maxExcerptChars / 2)}`;

        const findings = [`Output excerpt:\n${excerpt}`];
        const omissions = `Full original output (${rawResult.length} chars) retained in canonical transcript evidence. AI summarization was not completed.`;
        const unresolved = [
            "Tool output could not be fully summarized by AI pass; raw evidence is preserved.",
        ];

        const estTokens = estimateTokens(
            formatMilestoneEstimatePayload(summary, findings, [], unresolved, omissions),
            this.charsPerToken,
        );

        return validateToolMilestone({
            id: milestoneId,
            parentGoalId: options.parentGoalId,
            callId: options.callId,
            toolName: options.toolName,
            arguments: options.arguments,
            executionStatus: "completed",
            processingStatus: "failed", // Not marked as completed milestone!
            durationMs: options.durationMs,
            summary,
            findings,
            sourceLocations: [],
            relationships: [],
            unresolvedQuestions: unresolved,
            omissions,
            evidenceRefs: [evidenceRef],
            estimatedTokens: estTokens,
        });
    };
}

export const createMilestoneProcessor = (options?: MilestoneProcessorOptions): MilestoneProcessor =>
    new DefaultMilestoneProcessor(options);
