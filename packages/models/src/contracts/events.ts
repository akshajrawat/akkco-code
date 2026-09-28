export interface ModelTextEvent {
    type: "text";
    content: string;
}

export interface ModelToolCallEvent {
    type: "tool_call";
    id: string;
    name: string;
    arguments: unknown;
}

export type ModelEvent = ModelTextEvent | ModelToolCallEvent;
