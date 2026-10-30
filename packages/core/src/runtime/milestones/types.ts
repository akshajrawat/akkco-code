export type MilestoneExecutionStatus = "completed" | "failed" | "cancelled";
export type MilestoneProcessingStatus = "pending" | "completed" | "failed";

export interface ToolMilestone {
    readonly id: string;
    readonly parentGoalId: string;
    readonly callId: string;

    readonly toolName: string;
    readonly arguments: unknown;

    readonly executionStatus: MilestoneExecutionStatus;
    readonly processingStatus: MilestoneProcessingStatus;
    readonly error?: string;
    readonly durationMs?: number;

    readonly summary: string;
    readonly findings: readonly string[];
    readonly sourceLocations?: readonly string[];
    readonly relationships?: readonly string[];
    readonly unresolvedQuestions?: readonly string[];
    readonly omissions?: string;

    readonly evidenceRefs: readonly string[];
    readonly estimatedTokens: number;
}

export const validateToolMilestone = (data: unknown): ToolMilestone => {
    if (!data || typeof data !== "object") {
        throw new TypeError("Invalid milestone: output must be an object");
    }

    const obj = data as Record<string, unknown>;

    if (typeof obj.id !== "string" || obj.id.trim() === "") {
        throw new TypeError("Invalid milestone: id must be a non-empty string");
    }
    if (typeof obj.parentGoalId !== "string") {
        throw new TypeError("Invalid milestone: parentGoalId must be a string");
    }
    if (typeof obj.callId !== "string" || obj.callId.trim() === "") {
        throw new TypeError("Invalid milestone: callId must be a non-empty string");
    }
    if (typeof obj.toolName !== "string" || obj.toolName.trim() === "") {
        throw new TypeError("Invalid milestone: toolName must be a non-empty string");
    }

    const validExecStatuses: MilestoneExecutionStatus[] = ["completed", "failed", "cancelled"];
    if (
        typeof obj.executionStatus !== "string" ||
        !validExecStatuses.includes(obj.executionStatus as any)
    ) {
        throw new TypeError(
            `Invalid milestone: executionStatus must be one of ${validExecStatuses.join(", ")}`,
        );
    }

    const validProcStatuses: MilestoneProcessingStatus[] = ["pending", "completed", "failed"];
    if (
        typeof obj.processingStatus !== "string" ||
        !validProcStatuses.includes(obj.processingStatus as any)
    ) {
        throw new TypeError(
            `Invalid milestone: processingStatus must be one of ${validProcStatuses.join(", ")}`,
        );
    }

    if (typeof obj.summary !== "string") {
        throw new TypeError("Invalid milestone: summary must be a string");
    }

    if (!Array.isArray(obj.findings) || !obj.findings.every((f) => typeof f === "string")) {
        throw new TypeError("Invalid milestone: findings must be an array of strings");
    }

    if (
        obj.sourceLocations !== undefined &&
        (!Array.isArray(obj.sourceLocations) ||
            !obj.sourceLocations.every((s) => typeof s === "string"))
    ) {
        throw new TypeError(
            "Invalid milestone: sourceLocations must be an array of strings if defined",
        );
    }

    if (
        obj.relationships !== undefined &&
        (!Array.isArray(obj.relationships) ||
            !obj.relationships.every((r) => typeof r === "string"))
    ) {
        throw new TypeError(
            "Invalid milestone: relationships must be an array of strings if defined",
        );
    }

    if (
        obj.unresolvedQuestions !== undefined &&
        (!Array.isArray(obj.unresolvedQuestions) ||
            !obj.unresolvedQuestions.every((q) => typeof q === "string"))
    ) {
        throw new TypeError(
            "Invalid milestone: unresolvedQuestions must be an array of strings if defined",
        );
    }

    if (obj.omissions !== undefined && typeof obj.omissions !== "string") {
        throw new TypeError("Invalid milestone: omissions must be a string if defined");
    }

    if (!Array.isArray(obj.evidenceRefs) || !obj.evidenceRefs.every((e) => typeof e === "string")) {
        throw new TypeError("Invalid milestone: evidenceRefs must be an array of strings");
    }

    if (
        typeof obj.estimatedTokens !== "number" ||
        Number.isNaN(obj.estimatedTokens) ||
        obj.estimatedTokens < 0
    ) {
        throw new TypeError("Invalid milestone: estimatedTokens must be a non-negative number");
    }

    return {
        id: obj.id,
        parentGoalId: obj.parentGoalId,
        callId: obj.callId,
        toolName: obj.toolName,
        arguments: obj.arguments,
        executionStatus: obj.executionStatus as MilestoneExecutionStatus,
        processingStatus: obj.processingStatus as MilestoneProcessingStatus,
        error: typeof obj.error === "string" ? obj.error : undefined,
        durationMs: typeof obj.durationMs === "number" ? obj.durationMs : undefined,
        summary: obj.summary,
        findings: obj.findings as string[],
        sourceLocations: obj.sourceLocations as string[] | undefined,
        relationships: obj.relationships as string[] | undefined,
        unresolvedQuestions: obj.unresolvedQuestions as string[] | undefined,
        omissions: obj.omissions as string | undefined,
        evidenceRefs: obj.evidenceRefs as string[],
        estimatedTokens: obj.estimatedTokens,
    };
};
