export type MessageRole = "system" | "user" | "assistant";

export interface ModelMessageDocumentProvenance {
    readonly id: string;
    readonly sessionId: string;
    readonly startSequence: number;
    readonly endSequence: number;
    readonly similarity?: number;
}

export interface ModelMessageProvenance {
    readonly source: "policy" | "memory" | "history" | "user" | "repository";
    readonly relevance?: number;
    readonly documents?: readonly ModelMessageDocumentProvenance[];
}

export interface ModelMessage {
    type: "message";
    role: MessageRole;
    content: string;
    readonly isPolicy?: boolean;
    readonly provenance?: ModelMessageProvenance;
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
