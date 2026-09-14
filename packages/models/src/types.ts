export type MessageRole = "system" | "user" | "assistant";

export interface ModelMessage {
    role: MessageRole;
    content: string;
}

export interface ModelRequest {
    messages: ModelMessage[];
}

export interface ModelEvent {
    type: "text";
    content: string;
}