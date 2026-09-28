import type { ModelItem } from "@akkco/models";
import type { TranscriptItem } from "../transcript/types.js";

export const compileContext = (transcript: TranscriptItem[]): ModelItem[] => {
    const items: ModelItem[] = [];

    for (const item of transcript) {
        switch (item.type) {
            case "system": {
                items.push({
                    type: "message",
                    role: "system",
                    content: item.content,
                });
                break;
            }
            case "user": {
                items.push({
                    type: "message",
                    role: "user",
                    content: item.content,
                });
                break;
            }
            case "assistant": {
                if (item.status === "completed") {
                    items.push({
                        type: "message",
                        role: "assistant",
                        content: item.content,
                    });
                } else if (item.status === "interrupted") {
                    if (item.content.length > 0) {
                        items.push({
                            type: "message",
                            role: "assistant",
                            content: item.content,
                        });
                    }
                    items.push({
                        type: "message",
                        role: "system",
                        content: "[Previous assistant generation was interrupted before completion]",
                    });
                } else if (item.status === "failed") {
                    if (item.content.length > 0) {
                        items.push({
                            type: "message",
                            role: "assistant",
                            content: item.content,
                        });
                    }
                    items.push({
                        type: "message",
                        role: "system",
                        content: "[Previous assistant generation failed]",
                    });
                }
                break;
            }
            case "tool_execution": {
                items.push({
                    type: "tool_call",
                    id: item.callId,
                    name: item.toolName,
                    arguments: item.arguments,
                });

                if (item.status === "completed") {
                    items.push({
                        type: "tool_result",
                        callId: item.callId,
                        content: item.result ?? "",
                    });
                } else if (item.status === "failed") {
                    items.push({
                        type: "tool_result",
                        callId: item.callId,
                        content: item.error ?? "Tool execution failed",
                        isError: true,
                    });
                } else if (item.status === "cancelled") {
                    items.push({
                        type: "tool_result",
                        callId: item.callId,
                        content: "Tool execution cancelled",
                        isError: true,
                    });
                }
                break;
            }
        }
    }

    return items;
};
