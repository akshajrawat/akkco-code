import type { ToolMilestone } from "./milestones/types.js";

export type RuntimeTextEvent = {
    type: "text";
    content: string;
};

export type RuntimeToolExecutionEvent = {
    type: "tool_execution";
    callId: string;
    toolName: string;
    arguments: unknown;
    result?: string;
    error?: string;
    status: "completed" | "failed" | "cancelled";
    durationMs?: number;
    milestone?: ToolMilestone;
};

export type RuntimeEvent = RuntimeTextEvent | RuntimeToolExecutionEvent;
