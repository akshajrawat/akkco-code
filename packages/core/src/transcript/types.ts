export type SystemTranscriptItem = {
    type: "system";
    content: string;
};

export type UserTranscriptItem = {
    type: "user";
    content: string;
};

export type AssistantTranscriptItem = {
    type: "assistant";
    content: string;
    status: "completed" | "interrupted" | "failed";
};

export type ToolExecutionTranscriptItem = {
    type: "tool_execution";
    callId: string;
    toolName: string;
    arguments: unknown;
    result?: string;
    error?: string;
    status: "requested" | "running" | "completed" | "failed" | "cancelled";
    durationMs?: number;
};

export type TranscriptItem =
    | SystemTranscriptItem
    | UserTranscriptItem
    | AssistantTranscriptItem
    | ToolExecutionTranscriptItem;
