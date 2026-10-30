/**
 * Deterministic milestone extractors for standard repository tools and small outputs.
 * Avoids unnecessary LLM inference while producing accurate, structured evidence.
 */

import { estimateTokens } from "../../context/token-estimator.js";
import { validateEvidence } from "./evidence-validator.js";
import type { ProcessToolMilestoneOptions, ToolMilestone } from "./types.js";

/**
 * Builds a deterministic milestone for failed or cancelled tool executions.
 */
export const extractFailureMilestone = (
    options: ProcessToolMilestoneOptions,
    charsPerToken: number,
): ToolMilestone => {
    const errorText = options.error ?? "Tool execution failed without explicit error message";
    const isCancelled = options.executionStatus === "cancelled";
    const statusLabel = isCancelled ? "cancelled" : "failed";

    const summary = `${statusLabel} execution of "${options.toolName}": ${errorText}`;
    const unresolved = [
        isCancelled
            ? "Operation was cancelled by user or signal."
            : `Tool failed with error: ${errorText}`,
    ];

    const milestoneId = `milestone-${options.callId}`;
    const evidenceRef = `call:${options.callId}`;

    return {
        id: milestoneId,
        parentGoalId: options.parentGoalId,
        callId: options.callId,
        toolName: options.toolName,
        arguments: options.arguments,
        executionStatus: options.executionStatus,
        processingStatus: "completed",
        error: errorText,
        durationMs: options.durationMs,
        summary,
        findings: [],
        sourceLocations: [],
        unresolvedQuestions: unresolved,
        evidenceRefs: [evidenceRef],
        estimatedTokens: estimateTokens(summary + "\n" + unresolved.join("\n"), charsPerToken),
    };
};

/**
 * Deterministic extractor for list_files.
 */
export const extractListFilesMilestone = (
    options: ProcessToolMilestoneOptions,
    charsPerToken: number,
): ToolMilestone => {
    const raw = options.rawResult ?? "";
    const lines = raw
        .split("\n")
        .map((l: string) => l.trim())
        .filter(Boolean);
    const targetDir =
        (options.arguments as Record<string, unknown> | null)?.path ?? "repository root";

    const summary = `Listed directory "${targetDir}": found ${lines.length} entries`;
    const findings: string[] = [];

    const directories = lines.filter((l: string) => l.endsWith("/"));
    const files = lines.filter((l: string) => !l.endsWith("/"));

    if (lines.length <= 10) {
        for (const line of lines) {
            findings.push(line);
        }
    } else {
        if (directories.length > 0) {
            findings.push(
                `Directories (${directories.length}): ${directories.slice(0, 10).join(", ")}${
                    directories.length > 10 ? "..." : ""
                }`,
            );
        }
        if (files.length > 0) {
            findings.push(
                `Files (${files.length}): ${files.slice(0, 15).join(", ")}${files.length > 15 ? "..." : ""}`,
            );
        }
    }

    const sourceLocations = files.slice(0, 30);
    const milestoneId = `milestone-${options.callId}`;
    const evidenceRef = `call:${options.callId}`;

    return {
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
        evidenceRefs: [evidenceRef],
        estimatedTokens: estimateTokens(
            [summary, ...findings, ...sourceLocations].join("\n"),
            charsPerToken,
        ),
    };
};

/**
 * Deterministic extractor for read_file.
 */
export const extractReadFileMilestone = (
    options: ProcessToolMilestoneOptions,
    charsPerToken: number,
): ToolMilestone => {
    const raw = options.rawResult ?? "";
    const filePath = (options.arguments as Record<string, unknown> | null)?.path ?? "unknown file";
    const lines = raw.split("\n");
    const lineCount = lines.length;
    const charCount = raw.length;

    const summary = `Read file "${filePath}" (${lineCount} lines, ${charCount} chars)`;
    const findings: string[] = [];

    const previewLines = lines
        .slice(0, 5)
        .filter((l: string) => l.trim().length > 0)
        .map((l: string) => (l.length > 120 ? l.slice(0, 120) + "..." : l));
    if (previewLines.length > 0) {
        findings.push(`Preview: ${previewLines.map((l: string) => l.trim()).join(" | ")}`);
    }

    const sourceLocations = [String(filePath)];
    const milestoneId = `milestone-${options.callId}`;
    const evidenceRef = `call:${options.callId}`;

    return {
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
        evidenceRefs: [evidenceRef],
        estimatedTokens: estimateTokens(
            [summary, ...findings, ...sourceLocations].join("\n"),
            charsPerToken,
        ),
    };
};

/**
 * Deterministic extractor for search_text.
 */
export const extractSearchTextMilestone = (
    options: ProcessToolMilestoneOptions,
    charsPerToken: number,
): ToolMilestone => {
    const raw = options.rawResult ?? "";
    const query = (options.arguments as Record<string, unknown> | null)?.query ?? "";
    const searchLines = raw.split("\n").filter((l: string) => l.trim().length > 0);

    const matches: string[] = [];
    const rawLocations: string[] = [];

    for (const line of searchLines) {
        const parts = line.split(":");
        if (parts.length >= 3) {
            const relPath = parts[0];
            const lineNum = parts[1];
            const loc = `${relPath}:${lineNum}`;
            if (!rawLocations.includes(loc)) {
                rawLocations.push(loc);
            }
            if (matches.length < 10) {
                matches.push(line.trim());
            }
        }
    }

    const validation = validateEvidence(
        rawLocations,
        matches,
        options.toolName,
        options.arguments,
        raw,
    );

    const summary = `Searched for "${query}": found ${rawLocations.length} matches across ${
        new Set(rawLocations.map((l) => l.split(":")[0])).size
    } files`;

    const findings: string[] = [
        ...validation.establishedFindings.slice(0, 8),
        ...(rawLocations.length > 8
            ? [`... and ${rawLocations.length - 8} more matches omitted`]
            : []),
    ];

    const milestoneId = `milestone-${options.callId}`;
    const evidenceRef = `call:${options.callId}`;

    return {
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
        sourceLocations: validation.verifiedLocations.slice(0, 20),
        evidenceRefs: [evidenceRef],
        estimatedTokens: estimateTokens(
            [summary, ...findings, ...validation.verifiedLocations.slice(0, 20)].join("\n"),
            charsPerToken,
        ),
    };
};

/**
 * Deterministic extractor for generic short tool results.
 */
export const extractGenericDeterministicMilestone = (
    options: ProcessToolMilestoneOptions,
    charsPerToken: number,
): ToolMilestone => {
    const raw = options.rawResult ?? "";
    const summary = `Executed "${options.toolName}": output received (${raw.length} characters)`;
    const rawLines = raw
        .split("\n")
        .map((l: string) => l.trim())
        .filter(Boolean);
    const findings = rawLines
        .slice(0, 3)
        .map((line: string) => (line.length > 80 ? line.slice(0, 80) + "..." : line));

    const milestoneId = `milestone-${options.callId}`;
    const evidenceRef = `call:${options.callId}`;

    return {
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
        evidenceRefs: [evidenceRef],
        estimatedTokens: estimateTokens([summary, ...findings].join("\n"), charsPerToken),
    };
};
