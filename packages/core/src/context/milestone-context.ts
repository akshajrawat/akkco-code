import type { ModelItem } from "@akkco/models";
import type { ToolMilestone } from "../runtime/milestones/types.js";
import type { TranscriptItem } from "../transcript/types.js";

/**
 * Formats a single ToolMilestone into an evidence block suitable for model consumption.
 */
export const formatMilestoneText = (milestone: ToolMilestone): string => {
    const lines: string[] = [
        `[Milestone: ${milestone.toolName} (call_id: "${milestone.callId}") - Execution: ${milestone.executionStatus}, Processing: ${milestone.processingStatus}]`,
        `Summary: ${milestone.summary}`,
    ];

    if (milestone.findings && milestone.findings.length > 0) {
        lines.push("Findings:");
        for (const finding of milestone.findings) {
            lines.push(`- ${finding}`);
        }
    }

    if (milestone.sourceLocations && milestone.sourceLocations.length > 0) {
        lines.push(`Source Locations: ${milestone.sourceLocations.join(", ")}`);
    }

    if (milestone.relationships && milestone.relationships.length > 0) {
        lines.push("Relationships:");
        for (const rel of milestone.relationships) {
            lines.push(`- ${rel}`);
        }
    }

    if (milestone.unresolvedQuestions && milestone.unresolvedQuestions.length > 0) {
        lines.push("Unresolved Issues / Limitations:");
        for (const q of milestone.unresolvedQuestions) {
            lines.push(`- ${q}`);
        }
    }

    if (milestone.omissions) {
        lines.push(`Omissions: ${milestone.omissions}`);
    }

    if (milestone.evidenceRefs && milestone.evidenceRefs.length > 0) {
        lines.push(
            `Evidence Reference: ${milestone.evidenceRefs.join(", ")} (retained in canonical transcript)`,
        );
    }

    return lines.join("\n");
};

/**
 * Encapsulates a milestone as a non-policy user role ModelItem with repository provenance.
 * This guarantees the milestone cannot be confused with the root user prompt or system instructions.
 */
export const formatMilestoneAsModelItem = (milestone: ToolMilestone): ModelItem => {
    return {
        type: "message",
        role: "user",
        content: formatMilestoneText(milestone),
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

    // Append each completed milestone as an independent evidence item
    for (const milestone of completedMilestones) {
        items.push(formatMilestoneAsModelItem(milestone));
    }

    return items;
};

/**
 * Recovers the full original tool output from a session transcript given a call ID or milestone ID.
 */
export const recoverMilestoneEvidence = (
    transcript: readonly TranscriptItem[],
    callIdOrMilestoneId: string,
): string | undefined => {
    const targetCallId = callIdOrMilestoneId.startsWith("milestone-")
        ? callIdOrMilestoneId.slice("milestone-".length)
        : callIdOrMilestoneId;

    for (const item of transcript) {
        if (item.type === "tool_execution" && item.callId === targetCallId) {
            return item.result;
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
