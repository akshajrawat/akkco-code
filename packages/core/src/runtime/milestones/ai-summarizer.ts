/**
 * Bounded zero-tool AI summarizer for large tool execution outputs.
 * Extracts structured evidence while strictly prohibiting tool invocation during summarization.
 */

import type { ModelProfile, ModelProvider, ModelRequest } from "@akkco/models";
import { calculateMaxInputTokens } from "../../context/budget.js";
import { estimateTokens } from "../../context/token-estimator.js";
import { validateEvidence } from "./evidence-validator.js";
import type { ProcessToolMilestoneOptions, ToolMilestone } from "./types.js";

export interface AiSummarizerResult {
    readonly summary: string;
    readonly findings: readonly string[];
    readonly sourceLocations: readonly string[];
    readonly relationships?: readonly string[];
    readonly unresolvedQuestions?: readonly string[];
    readonly omissions?: string;
}

/**
 * Runs a zero-tool AI summarization pass on substantial tool output.
 * Returns null if summarization fails or output is malformed.
 */
export const executeAiSummarizer = async (
    options: ProcessToolMilestoneOptions,
    provider: ModelProvider,
    profile: ModelProfile | undefined,
    charsPerToken: number,
    targetMaxTokens: number,
): Promise<AiSummarizerResult | null> => {
    const rawResult = options.rawResult ?? "";
    const compactorCapacity = profile ? calculateMaxInputTokens(profile) : 8192;

    const systemPrompt = [
        "You are an evidence summarizer. Your role is to convert raw tool execution results into a compact, evidence-backed milestone.",
        "Rules:",
        "1. Extract ONLY facts directly supported by the raw output. Never fabricate line numbers or file paths.",
        "2. Separate direct technical observations from interpretations, assumptions, or inferences.",
        "3. Include line citations as @line or @start-end in observations when relevant (e.g. 'Valid calls emit tool_call and return. @192-200').",
        "4. Output ONLY a valid JSON object matching this schema:",
        "{",
        '  "summary": "Concise 1-sentence takeaway of what was observed",',
        '  "findings": ["Direct technical observation 1 @line", "Direct technical observation 2"],',
        '  "interpretations": ["Conclusions, assumptions, or questions requiring further inspection"],',
        '  "sourceLocations": ["path/to/file.ext:lineNum"],',
        '  "unresolvedQuestions": ["Unresolved question or limitation"],',
        '  "omissions": "Summary of details, verbose logs, or formatting omitted for brevity"',
        "}",
    ].join("\n");

    const userContent = [
        `Goal: ${options.parentGoal}`,
        `Tool: ${options.toolName}`,
        `Arguments: ${JSON.stringify(options.arguments)}`,
        `Max milestone budget: ~${targetMaxTokens} tokens`,
        "",
        "Raw Output:",
        rawResult,
    ].join("\n");

    const promptTokens =
        estimateTokens(systemPrompt, charsPerToken) + estimateTokens(userContent, charsPerToken);

    if (promptTokens > compactorCapacity) {
        // Output exceeds single prompt capacity: cannot safely summarize in one shot
        return null;
    }

    const request: ModelRequest = {
        items: [
            { type: "message", role: "system", content: systemPrompt },
            { type: "message", role: "user", content: userContent },
        ],
        tools: undefined, // Never allow summarizer to invoke tools
        signal: options.signal,
        profile,
    };

    let responseText = "";
    for await (const event of provider.stream(request)) {
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

    const rawFindings = (parsed.findings as unknown[])
        .filter((f): f is string => typeof f === "string")
        .map((f) => f.trim())
        .filter(Boolean);

    const rawLocations = Array.isArray(parsed.sourceLocations)
        ? (parsed.sourceLocations as unknown[])
              .filter((l): l is string => typeof l === "string")
              .map((l) => l.trim())
              .filter(Boolean)
        : [];

    const rawRelationships = Array.isArray(parsed.relationships)
        ? (parsed.relationships as unknown[])
              .filter((r): r is string => typeof r === "string")
              .map((r) => r.trim())
              .filter(Boolean)
        : undefined;

    const rawInterpretations = Array.isArray(parsed.interpretations)
        ? (parsed.interpretations as unknown[])
              .filter((i): i is string => typeof i === "string")
              .map((i) => i.trim())
              .filter(Boolean)
        : [];

    const rawUnresolved = Array.isArray(parsed.unresolvedQuestions)
        ? (parsed.unresolvedQuestions as unknown[])
              .filter((q): q is string => typeof q === "string")
              .map((q) => q.trim())
              .filter(Boolean)
        : [];

    const rawOmissions = typeof parsed.omissions === "string" ? parsed.omissions.trim() : undefined;

    // Validate evidence against raw tool output format
    const evidence = validateEvidence(
        rawLocations,
        rawFindings,
        options.toolName,
        options.arguments,
        rawResult,
        rawInterpretations,
        rawUnresolved,
    );

    const findings = [...evidence.establishedFindings];
    const unresolvedQuestions = [...evidence.uncertainFindings];

    return {
        summary: parsed.summary.trim(),
        findings,
        sourceLocations: evidence.verifiedLocations,
        relationships: rawRelationships,
        unresolvedQuestions: unresolvedQuestions.length > 0 ? unresolvedQuestions : undefined,
        omissions: rawOmissions,
    };
};
