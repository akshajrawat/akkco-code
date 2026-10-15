import type { ModelItem } from "@akkco/models";
import type { TranscriptItem } from "../transcript/types.js";

/**
 * Conservative token estimator approximation (ceil(characters / 4)).
 */
export const estimateTokens = (text?: string): number => {
    if (!text || typeof text !== "string" || text.length === 0) {
        return 0;
    }
    return Math.ceil(text.length / 4);
};

export const estimateModelItemTokens = (item: ModelItem): number => {
    switch (item.type) {
        case "message": {
            // Include message framing overhead (role + formatting)
            return estimateTokens(item.content) + 4;
        }
        case "tool_call": {
            const argsStr =
                typeof item.arguments === "string"
                    ? item.arguments
                    : JSON.stringify(item.arguments ?? {});
            return estimateTokens(item.name) + estimateTokens(argsStr) + 4;
        }
        case "tool_result": {
            return estimateTokens(item.content) + 4;
        }
    }
};

export const estimateTranscriptItemTokens = (item: TranscriptItem): number => {
    switch (item.type) {
        case "system":
        case "user": {
            return estimateTokens(item.content) + 4;
        }
        case "assistant": {
            return estimateTokens(item.content) + 4;
        }
        case "tool_execution": {
            const argsStr =
                typeof item.arguments === "string"
                    ? item.arguments
                    : JSON.stringify(item.arguments ?? {});
            const resultStr = item.result ?? item.error ?? "";
            return (
                estimateTokens(item.toolName) +
                estimateTokens(argsStr) +
                estimateTokens(resultStr) +
                8
            );
        }
    }
};
