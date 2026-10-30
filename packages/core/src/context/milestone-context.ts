import type { ModelItem } from "@akkco/models";
import { estimateTokens } from "./token-estimator.js";
import type { MilestoneExecutionStatus, ToolMilestone } from "../runtime/milestones/types.js";
import type { ToolExecutionTranscriptItem, TranscriptItem } from "../transcript/types.js";

/**
 * Derives a clean, compact target identifier for a tool call.
 */
export const deriveMilestoneTarget = (toolName: string, args: unknown): string | undefined => {
    if (!args || typeof args !== "object") return undefined;
    const record = args as Record<string, unknown>;

    if (toolName === "read_file" && typeof record.path === "string") {
        const fullPath = record.path.trim();
        const base = fullPath.split("/").pop() ?? fullPath;
        return base;
    }
    if (toolName === "list_files" && typeof record.path === "string") {
        return record.path.trim() || ".";
    }
    if (toolName === "search_text" && typeof record.query === "string") {
        return `"${record.query.trim()}"`;
    }
    if (typeof record.path === "string") {
        return record.path.split("/").pop() ?? record.path;
    }
    if (typeof record.query === "string") {
        return `"${record.query.trim()}"`;
    }
    if (typeof record.id === "string") {
        return record.id;
    }
    return undefined;
};

/**
 * Derives the deterministic "Did:" field from tool execution facts.
 * Guaranteed to be deterministic and never hallucinated.
 */
export const deriveDeterministicDid = (
    toolName: string,
    args: unknown,
    executionStatus: MilestoneExecutionStatus,
    error?: string,
    rawResult?: string,
): string => {
    const isCancelled = executionStatus === "cancelled";
    const isFailed = executionStatus === "failed";
    const target = deriveMilestoneTarget(toolName, args);

    if (isCancelled) {
        return `Cancelled execution of ${toolName}${target ? ` (${target})` : ""}.`;
    }
    if (isFailed) {
        return `Attempted ${toolName}${target ? ` (${target})` : ""} (failed: ${error ?? "error"}).`;
    }

    if (toolName === "read_file") {
        const lineCount = rawResult ? rawResult.split("\n").length : 0;
        const lineNote = lineCount > 0 ? ` (${lineCount} lines)` : "";
        return `Read ${target ?? "file"}${lineNote}.`;
    }

    if (toolName === "list_files") {
        const count = rawResult ? rawResult.split("\n").filter((l) => l.trim()).length : 0;
        const countNote = count > 0 ? ` (${count} entries)` : "";
        return `Listed directory ${target ?? "root"}${countNote}.`;
    }

    if (toolName === "search_text") {
        const count = rawResult ? rawResult.split("\n").filter((l) => l.trim()).length : 0;
        const countNote = count > 0 ? ` (${count} matches)` : "";
        return `Searched for ${target ?? "query"}${countNote}.`;
    }

    return `Executed ${toolName}${target ? ` (${target})` : ""}.`;
};

/**
 * Formats a single ToolMilestone into the compact three-field representation:
 * M<index> | <toolName> | <target>
 *
 * Did: <operation>
 *
 * Summary:
 * - <observation 1>
 * - <observation 2>
 *
 * Needs recheck:
 * - <unresolved/unverified>
 */
export const formatMilestoneText = (milestone: ToolMilestone, index?: number): string => {
    // 1. Header: M<index> | <toolName> [| <target>]
    const idx = index ?? milestone.index ?? 1;
    const target = deriveMilestoneTarget(milestone.toolName, milestone.arguments);
    const header = target
        ? `M${idx} | ${milestone.toolName} | ${target}`
        : `M${idx} | ${milestone.toolName}`;

    // 2. Field 1: Did
    const didText =
        milestone.did ??
        deriveDeterministicDid(
            milestone.toolName,
            milestone.arguments,
            milestone.executionStatus,
            milestone.error,
        );

    // 3. Field 2: Summary (observations)
    const summaryLines: string[] = ["Summary:"];
    if (milestone.findings && milestone.findings.length > 0) {
        for (const finding of milestone.findings) {
            summaryLines.push(`- ${finding}`);
        }
    } else if (milestone.summary && milestone.summary.trim().length > 0) {
        summaryLines.push(`- ${milestone.summary.trim()}`);
    } else {
        summaryLines.push("- Completed without detailed observations.");
    }

    // 4. Field 3: Needs recheck
    const recheckLines: string[] = [];
    const questions = milestone.unresolvedQuestions ?? [];

    if (milestone.processingStatus === "failed") {
        recheckLines.push("- Milestone processing failed; verify raw result in transcript.");
    }

    for (const q of questions) {
        const line = `- ${q}`;
        if (!recheckLines.includes(line)) {
            recheckLines.push(line);
        }
    }

    const needsRecheckBlock =
        recheckLines.length > 0
            ? `Needs recheck:\n${recheckLines.join("\n")}`
            : "Needs recheck: None";

    return [header, "", `Did: ${didText}`, "", summaryLines.join("\n"), "", needsRecheckBlock].join(
        "\n",
    );
};

/**
 * Encapsulates a milestone as a non-policy user role ModelItem with repository provenance.
 * This guarantees the milestone cannot be confused with the root user prompt or system instructions.
 */
export const formatMilestoneAsModelItem = (milestone: ToolMilestone, index?: number): ModelItem => {
    return {
        type: "message",
        role: "user",
        content: formatMilestoneText(milestone, index),
        isPolicy: false,
        provenance: {
            source: "repository",
            documents: [
                {
                    id: milestone.id,
                    sessionId: milestone.parentGoalId,
                    startSequence: -1,
                    endSequence: -1,
                },
            ],
        },
    };
};

/**
 * Reconstructs the model-visible request context from the immutable initial user-turn context
 * plus completed milestones, ensuring completed historical tool exchanges do not endlessly accumulate
 * raw outputs and redundant assistant narration.
 */
export const reconstructContextWithMilestones = (
    baseItems: readonly ModelItem[],
    completedMilestones: readonly ToolMilestone[],
): ModelItem[] => {
    // Preserve base items (Policy prefix, History RAG documents, and the authoritative user goal)
    const items: ModelItem[] = baseItems.map((item) => ({ ...item }));

    // Append each completed milestone as an independent evidence item with 1-based sequential index
    for (let i = 0; i < completedMilestones.length; i++) {
        items.push(formatMilestoneAsModelItem(completedMilestones[i], i + 1));
    }

    return items;
};

/**
 * Recovers the full original tool output from a session transcript given a call ID or milestone ID.
 * Supports optional parentGoalId / sessionId for disambiguation when call IDs repeat across sessions.
 */
export const recoverMilestoneEvidence = (
    transcript: readonly TranscriptItem[],
    callIdOrMilestoneId: string,
    sessionIdOrGoalId?: string,
): string | undefined => {
    // Priority 1: Exact milestone ID match (most unambiguous across executions)
    for (const item of transcript) {
        if (item.type === "tool_execution" && item.milestone?.id === callIdOrMilestoneId) {
            if (!sessionIdOrGoalId || item.milestone.parentGoalId === sessionIdOrGoalId) {
                return item.result;
            }
        }
    }

    // Priority 2: Exact evidence reference match
    for (const item of transcript) {
        if (
            item.type === "tool_execution" &&
            item.milestone?.evidenceRefs?.includes(callIdOrMilestoneId)
        ) {
            if (!sessionIdOrGoalId || item.milestone.parentGoalId === sessionIdOrGoalId) {
                return item.result;
            }
        }
    }

    // Priority 3: Call ID match or evidence reference prefix
    for (const item of transcript) {
        if (item.type === "tool_execution") {
            const matchesCall =
                item.callId === callIdOrMilestoneId ||
                item.milestone?.callId === callIdOrMilestoneId ||
                item.milestone?.evidenceRefs?.includes(`call:${callIdOrMilestoneId}`) ||
                (callIdOrMilestoneId.startsWith("milestone-") &&
                    (item.milestone?.id?.includes(callIdOrMilestoneId) ||
                        callIdOrMilestoneId.endsWith(item.callId)));

            if (matchesCall) {
                if (!sessionIdOrGoalId || item.milestone?.parentGoalId === sessionIdOrGoalId) {
                    return item.result;
                }
            }
        }
    }

    return undefined;
};

/**
 * Finds the ToolMilestone associated with a specific tool call ID from a session transcript.
 */
export const findMilestoneByCallId = (
    transcript: readonly TranscriptItem[],
    callId: string,
): ToolMilestone | undefined => {
    for (const item of transcript) {
        if (item.type === "tool_execution" && item.callId === callId) {
            return item.milestone;
        }
    }

    return undefined;
};

/**
 * Normalizes a legacy tool_execution transcript item that lacks a milestone into a deterministic ToolMilestone.
 * Guarantees that even pre-migration sessions never replay raw tool results into model context.
 */
export const normalizeLegacyToolExecutionToMilestone = (
    item: ToolExecutionTranscriptItem,
    charsPerToken = 4,
): ToolMilestone => {
    const raw = item.result ?? "";
    const isError = item.status === "failed" || Boolean(item.error);
    const isCancelled = item.status === "cancelled";
    const execStatus: MilestoneExecutionStatus = isCancelled
        ? "cancelled"
        : isError
          ? "failed"
          : "completed";
    const summary = isError
        ? `Execution of "${item.toolName}" failed: ${item.error ?? "unknown error"}`
        : `Historical execution of "${item.toolName}" (${raw.length} characters)`;

    const rawLines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const findings = isError ? [] : rawLines.slice(0, 3);

    return {
        id: `legacy-${item.callId}`,
        parentGoalId: "legacy-session",
        callId: item.callId,
        toolName: item.toolName,
        arguments: item.arguments,
        executionStatus: execStatus,
        processingStatus: "completed",
        error: item.error,
        durationMs: item.durationMs,
        summary,
        findings,
        unresolvedQuestions: isError ? [item.error ?? "Tool execution failed"] : undefined,
        omissions:
            raw.length > 200
                ? "Historical details omitted; full raw output preserved in transcript."
                : undefined,
        evidenceRefs: [`call:${item.callId}`],
        estimatedTokens: estimateTokens(summary + "\n" + findings.join("\n"), charsPerToken),
    };
};
