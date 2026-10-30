import type { ModelProfile, ModelProvider } from "@akkco/models";
import { deriveDeterministicDid, formatMilestoneText } from "../../context/milestone-context.js";
import { calculateMaxInputTokens, type ContextBudget } from "../../context/budget.js";
import { estimateTokens } from "../../context/token-estimator.js";
import { executeAiSummarizer } from "./ai-summarizer.js";
import {
    extractFailureMilestone,
    extractGenericDeterministicMilestone,
    extractListFilesMilestone,
    extractReadFileMilestone,
    extractSearchTextMilestone,
} from "./deterministic-extractor.js";
import {
    type MilestoneExecutionStatus,
    type MilestoneProcessor,
    type MilestoneProcessorOptions,
    type ProcessToolMilestoneOptions,
    type ToolMilestone,
    validateToolMilestone,
} from "./types.js";

export type { MilestoneProcessor, MilestoneProcessorOptions, ProcessToolMilestoneOptions };

export const DEFAULT_MAX_MILESTONE_TOKENS = 1200;
export const DEFAULT_DETERMINISTIC_THRESHOLD_TOKENS = 250;

/**
 * Standard implementation of MilestoneProcessor providing deterministic extraction
 * for short or known tool outputs, bounded AI summarization for large outputs,
 * and robust token limit enforcement.
 */
export class DefaultMilestoneProcessor implements MilestoneProcessor {
    private readonly provider?: ModelProvider;
    private readonly profile?: ModelProfile;
    private readonly maxMilestoneTokens: number;
    private readonly deterministicThresholdTokens: number;
    private readonly charsPerToken: number;

    constructor(options?: MilestoneProcessorOptions) {
        this.provider = options?.provider;
        this.profile = options?.profile;
        const profileCapacity = options?.profile
            ? calculateMaxInputTokens(options.profile)
            : options?.budget
              ? options.budget.preferredInputTokens
              : undefined;
        const budgetCap =
            profileCapacity !== undefined
                ? Math.max(20, Math.floor(profileCapacity * 0.3))
                : undefined;
        this.maxMilestoneTokens = options?.maxMilestoneTokens
            ? budgetCap !== undefined
                ? Math.min(options.maxMilestoneTokens, budgetCap)
                : options.maxMilestoneTokens
            : budgetCap !== undefined
              ? Math.min(DEFAULT_MAX_MILESTONE_TOKENS, budgetCap)
              : DEFAULT_MAX_MILESTONE_TOKENS;
        this.deterministicThresholdTokens =
            options?.deterministicThresholdTokens ?? DEFAULT_DETERMINISTIC_THRESHOLD_TOKENS;
        this.charsPerToken = options?.charsPerToken ?? options?.profile?.charsPerToken ?? 4;
    }

    async processToolExecution(options: ProcessToolMilestoneOptions): Promise<ToolMilestone> {
        if (options.signal?.aborted) {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            throw err;
        }

        const effectiveProfile = options.profile ?? this.profile;
        const profileCapacity = effectiveProfile
            ? calculateMaxInputTokens(effectiveProfile)
            : undefined;
        const dynamicLimit =
            profileCapacity !== undefined
                ? Math.max(20, Math.floor(profileCapacity * 0.28))
                : undefined;
        const effectiveMaxTokens =
            dynamicLimit !== undefined
                ? Math.min(this.maxMilestoneTokens, dynamicLimit)
                : this.maxMilestoneTokens;

        // 1. If tool execution failed or was cancelled, create failure milestone directly
        if (options.executionStatus !== "completed") {
            const milestone = extractFailureMilestone(options, this.charsPerToken);
            return validateToolMilestone(
                this.enforceTokenBudget(milestone, options, effectiveMaxTokens),
            );
        }

        const rawResult = options.rawResult ?? "";
        const rawTokens = estimateTokens(rawResult, this.charsPerToken);

        // 2. Deterministic path for small results or when no summarizer provider is configured
        const isSmallOutput = rawTokens <= this.deterministicThresholdTokens;
        const isKnownRepoTool = ["list_files", "read_file", "search_text"].includes(
            options.toolName,
        );

        if (isSmallOutput || !this.provider) {
            let milestone: ToolMilestone;
            switch (options.toolName) {
                case "list_files":
                    milestone = extractListFilesMilestone(options, this.charsPerToken);
                    break;
                case "read_file":
                    milestone = extractReadFileMilestone(options, this.charsPerToken);
                    break;
                case "search_text":
                    milestone = extractSearchTextMilestone(options, this.charsPerToken);
                    break;
                default:
                    milestone = extractGenericDeterministicMilestone(options, this.charsPerToken);
                    break;
            }
            return validateToolMilestone(
                this.enforceTokenBudget(milestone, options, effectiveMaxTokens),
            );
        }

        // 3. AI Summarization path for substantial outputs when provider is present
        try {
            const aiResult = await executeAiSummarizer(
                options,
                this.provider,
                effectiveProfile,
                this.charsPerToken,
                effectiveMaxTokens,
            );

            if (aiResult) {
                const milestoneId = `milestone-${options.callId}`;
                const evidenceRef = `call:${options.callId}`;

                const did = deriveDeterministicDid(
                    options.toolName,
                    options.arguments,
                    "completed",
                    undefined,
                    options.rawResult,
                );

                const candidateMilestone: ToolMilestone = {
                    id: milestoneId,
                    parentGoalId: options.parentGoalId,
                    callId: options.callId,
                    toolName: options.toolName,
                    arguments: options.arguments,
                    executionStatus: "completed",
                    processingStatus: "completed",
                    durationMs: options.durationMs,
                    did,
                    summary: aiResult.summary,
                    findings: aiResult.findings,
                    sourceLocations: aiResult.sourceLocations,
                    relationships: aiResult.relationships,
                    unresolvedQuestions: aiResult.unresolvedQuestions,
                    omissions: aiResult.omissions,
                    evidenceRefs: [evidenceRef],
                    estimatedTokens: 0, // calculated by enforceTokenBudget
                    index: options.index,
                };

                return validateToolMilestone(
                    this.enforceTokenBudget(candidateMilestone, options, effectiveMaxTokens),
                );
            }
        } catch (error) {
            if (
                options.signal?.aborted ||
                (error instanceof Error && error.name === "AbortError")
            ) {
                throw error;
            }
            // AI summarization error falls through to explicit fallback
        }

        // 4. Fallback when AI summarization fails or output was malformed
        return validateToolMilestone(
            this.createFallbackMilestone(options, rawResult, effectiveMaxTokens),
        );
    }

    /**
     * Enforces the maxMilestoneTokens limit on the complete formatted milestone.
     */
    private enforceTokenBudget(
        milestone: ToolMilestone,
        options: ProcessToolMilestoneOptions,
        maxTokens: number,
    ): ToolMilestone {
        let currentMilestone = { ...milestone };
        let formattedText = formatMilestoneText(currentMilestone);
        let tokens = estimateTokens(formattedText, this.charsPerToken);

        if (tokens <= maxTokens) {
            return {
                ...currentMilestone,
                estimatedTokens: tokens,
            };
        }

        // Output exceeds limit: trim non-essential fields progressively
        let findings = [...currentMilestone.findings];
        let relationships = currentMilestone.relationships
            ? [...currentMilestone.relationships]
            : undefined;
        let locations = currentMilestone.sourceLocations
            ? [...currentMilestone.sourceLocations]
            : undefined;

        // Step A: drop relationships
        if (relationships && relationships.length > 0) {
            relationships = undefined;
            currentMilestone = {
                ...currentMilestone,
                relationships,
                omissions:
                    (currentMilestone.omissions ? currentMilestone.omissions + "; " : "") +
                    "Relationships omitted for token budget",
            };
            formattedText = formatMilestoneText(currentMilestone);
            tokens = estimateTokens(formattedText, this.charsPerToken);
            if (tokens <= maxTokens) {
                return { ...currentMilestone, estimatedTokens: tokens };
            }
        }

        // Step B: reduce findings to top 3, then top 1
        if (findings.length > 3) {
            const omittedCount = findings.length - 3;
            findings = findings.slice(0, 3);
            currentMilestone = {
                ...currentMilestone,
                findings,
                omissions:
                    (currentMilestone.omissions ? currentMilestone.omissions + "; " : "") +
                    `${omittedCount} findings omitted for token budget`,
            };
            formattedText = formatMilestoneText(currentMilestone);
            tokens = estimateTokens(formattedText, this.charsPerToken);
            if (tokens <= maxTokens) {
                return { ...currentMilestone, estimatedTokens: tokens };
            }
        }

        if (findings.length > 1) {
            findings = findings.slice(0, 1);
            currentMilestone = {
                ...currentMilestone,
                findings,
                omissions:
                    (currentMilestone.omissions ? currentMilestone.omissions + "; " : "") +
                    "Additional findings omitted for token budget",
            };
            formattedText = formatMilestoneText(currentMilestone);
            tokens = estimateTokens(formattedText, this.charsPerToken);
            if (tokens <= maxTokens) {
                return { ...currentMilestone, estimatedTokens: tokens };
            }
        }

        // Step C: reduce source locations to top 5, then top 1
        if (locations && locations.length > 5) {
            locations = locations.slice(0, 5);
            currentMilestone = {
                ...currentMilestone,
                sourceLocations: locations,
            };
            formattedText = formatMilestoneText(currentMilestone);
            tokens = estimateTokens(formattedText, this.charsPerToken);
            if (tokens <= maxTokens) {
                return { ...currentMilestone, estimatedTokens: tokens };
            }
        }

        if (locations && locations.length > 1) {
            locations = locations.slice(0, 1);
            currentMilestone = {
                ...currentMilestone,
                sourceLocations: locations,
            };
            formattedText = formatMilestoneText(currentMilestone);
            tokens = estimateTokens(formattedText, this.charsPerToken);
            if (tokens <= maxTokens) {
                return { ...currentMilestone, estimatedTokens: tokens };
            }
        }

        // Step D: Drop findings and locations completely before marking failure
        if (findings.length > 0 || (locations && locations.length > 0)) {
            findings = [];
            locations = undefined;
            currentMilestone = {
                ...currentMilestone,
                findings,
                sourceLocations: locations,
                omissions: "Findings and locations omitted to fit within token budget.",
            };
            formattedText = formatMilestoneText(currentMilestone);
            tokens = estimateTokens(formattedText, this.charsPerToken);
            if (tokens <= maxTokens) {
                return { ...currentMilestone, estimatedTokens: tokens };
            }
        }

        // Step E: If still exceeding, cannot safely claim completed processing without violating budget
        // Mark processingStatus as failed, provide minimal safe summary, and preserve raw evidence reference
        let safeSummary = `Executed "${options.toolName}": output exceeds milestone token budget (${maxTokens} tokens).`;
        let unresolved: string[] | undefined = [
            `Milestone processing failed: formatted output exceeds limit of ${maxTokens} tokens.`,
        ];
        let omissions: string | undefined =
            `Output (${options.rawResult?.length ?? 0} chars) omitted to respect context limits.`;
        let evidenceRefs: readonly string[] = currentMilestone.evidenceRefs;

        let minimalFailedMilestone: ToolMilestone = {
            id: currentMilestone.id,
            parentGoalId: currentMilestone.parentGoalId,
            callId: currentMilestone.callId,
            toolName: currentMilestone.toolName,
            arguments: currentMilestone.arguments,
            executionStatus: currentMilestone.executionStatus,
            processingStatus: "failed", // Not completed!
            durationMs: currentMilestone.durationMs,
            did:
                currentMilestone.did ??
                deriveDeterministicDid(
                    currentMilestone.toolName,
                    currentMilestone.arguments,
                    currentMilestone.executionStatus,
                    currentMilestone.error,
                    options.rawResult,
                ),
            summary: safeSummary,
            findings: [],
            unresolvedQuestions: unresolved,
            omissions,
            evidenceRefs,
            estimatedTokens: 0,
            index: currentMilestone.index ?? options.index,
        };

        formattedText = formatMilestoneText(minimalFailedMilestone);
        tokens = estimateTokens(formattedText, this.charsPerToken);

        if (tokens > maxTokens) {
            // Trim non-essential commentary if budget is extremely tight
            minimalFailedMilestone = {
                ...minimalFailedMilestone,
                unresolvedQuestions: undefined,
                omissions: undefined,
            };
            formattedText = formatMilestoneText(minimalFailedMilestone);
            tokens = estimateTokens(formattedText, this.charsPerToken);
        }

        if (tokens > maxTokens) {
            // Trim summary and verbose evidence note if budget is still tight
            minimalFailedMilestone = {
                ...minimalFailedMilestone,
                summary: `Output exceeds ${maxTokens}t limit; raw preserved.`,
                evidenceRefs: [],
            };
            formattedText = formatMilestoneText(minimalFailedMilestone);
            tokens = estimateTokens(formattedText, this.charsPerToken);
        }

        return {
            ...minimalFailedMilestone,
            estimatedTokens: tokens,
        };
    }

    private createFallbackMilestone(
        options: ProcessToolMilestoneOptions,
        rawResult: string,
        maxTokens?: number,
    ): ToolMilestone {
        const milestoneId = `milestone-${options.callId}`;
        const evidenceRef = `call:${options.callId}`;
        const did = deriveDeterministicDid(
            options.toolName,
            options.arguments,
            "completed",
            undefined,
            rawResult,
        );
        const summary = `Executed "${options.toolName}" (${rawResult.length} characters): AI summarization failed; raw evidence preserved in transcript.`;
        const rawLines = rawResult
            .split("\n")
            .map((l: string) => l.trim())
            .filter(Boolean);
        const findings = rawLines
            .slice(0, 3)
            .map((l: string) => (l.length > 80 ? l.slice(0, 80) + "..." : l));
        const unresolved = [
            "AI summarization was unavailable or failed; verify raw result in transcript.",
        ];

        const fallback: ToolMilestone = {
            id: milestoneId,
            parentGoalId: options.parentGoalId,
            callId: options.callId,
            toolName: options.toolName,
            arguments: options.arguments,
            executionStatus: "completed", // Tool itself succeeded!
            processingStatus: "failed", // But milestone processing failed!
            durationMs: options.durationMs,
            did,
            summary,
            findings,
            unresolvedQuestions: unresolved,
            omissions: `AI summarization was not completed; raw output (${rawResult.length} chars) preserved in canonical transcript.`,
            evidenceRefs: [evidenceRef],
            estimatedTokens: estimateTokens(
                summary + "\n" + findings.join("\n") + "\n" + unresolved.join("\n"),
                this.charsPerToken,
            ),
            index: options.index,
        };

        return this.enforceTokenBudget(fallback, options, maxTokens ?? this.maxMilestoneTokens);
    }
}

export const createMilestoneProcessor = (options?: MilestoneProcessorOptions): MilestoneProcessor =>
    new DefaultMilestoneProcessor(options);
