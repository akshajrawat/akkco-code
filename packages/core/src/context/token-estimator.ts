import type { ModelItem } from "@akkco/models";
import type { TranscriptItem } from "../transcript/types.js";

/**
 * Conservative token estimator approximation (ceil(characters / charsPerToken)).
 */
export const estimateTokens = (text?: string, charsPerToken = 4): number => {
    if (!text || typeof text !== "string" || text.length === 0) {
        return 0;
    }
    const rate = charsPerToken > 0 ? charsPerToken : 4;
    return Math.ceil(text.length / rate);
};

export const estimateModelItemTokens = (item: ModelItem, charsPerToken = 4): number => {
    switch (item.type) {
        case "message": {
            // Include message framing overhead (role + formatting)
            return estimateTokens(item.content, charsPerToken) + 4;
        }
        case "tool_call": {
            const argsStr =
                typeof item.arguments === "string"
                    ? item.arguments
                    : JSON.stringify(item.arguments ?? {});
            return (
                estimateTokens(item.name, charsPerToken) +
                estimateTokens(argsStr, charsPerToken) +
                4
            );
        }
        case "tool_result": {
            return estimateTokens(item.content, charsPerToken) + 4;
        }
    }
};

export const estimateTranscriptItemTokens = (item: TranscriptItem, charsPerToken = 4): number => {
    switch (item.type) {
        case "system":
        case "user": {
            return estimateTokens(item.content, charsPerToken) + 4;
        }
        case "assistant": {
            return estimateTokens(item.content, charsPerToken) + 4;
        }
        case "tool_execution": {
            const argsStr =
                typeof item.arguments === "string"
                    ? item.arguments
                    : JSON.stringify(item.arguments ?? {});
            const resultStr = item.result ?? item.error ?? "";
            return (
                estimateTokens(item.toolName, charsPerToken) +
                estimateTokens(argsStr, charsPerToken) +
                estimateTokens(resultStr, charsPerToken) +
                8
            );
        }
    }
};
