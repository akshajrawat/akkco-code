export type MessageRole = "system" | "user" | "assistant";

export interface ModelMessage {
    role: MessageRole;
    content: string;
}

export interface ModelRequest {
    messages: ModelMessage[];
    signal?: AbortSignal;
}

export interface ModelEvent {
    type: "text";
    content: string;
}