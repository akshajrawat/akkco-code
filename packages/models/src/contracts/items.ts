export type MessageRole = "system" | "user" | "assistant";

export interface ModelMessage {
    type: "message";
    role: MessageRole;
    content: string;
}

export interface ModelToolCall {
    type: "tool_call";
    id: string;
    name: string;
    arguments: unknown;
}

export interface ModelToolResult {
    type: "tool_result";
    callId: string;
    content: string;
    isError?: boolean;
}

export type ModelItem = ModelMessage | ModelToolCall | ModelToolResult;
