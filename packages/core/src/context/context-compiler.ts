import type { ModelItem } from "@akkco/models";
import type { TranscriptItem } from "../transcript/types.js";
import {
    formatMilestoneAsModelItem,
    normalizeLegacyToolExecutionToMilestone,
} from "./milestone-context.js";

export const AGENT_POLICY = `Repository behavior:
- Use repository tools only when the request depends on repository contents.
- Base repository-specific claims on tool evidence rather than guessing.
- After useful search results, inspect relevant files before broadening the search.
- Stop once enough evidence exists to answer.`;

export interface CompileContextOptions {
    includePolicy?: boolean;
    policy?: string;
}

/**
 * Compiles a raw canonical transcript into a provider-neutral ModelItem sequence,
 * injecting policy and converting transcript statuses into appropriate message and milestone items.
 * Milestone processing is always enabled; historical tool records without milestones are normalized
 * to preserve bounded context and avoid replaying raw outputs.
 */
export const compileContext = (
    transcript: TranscriptItem[],
    options?: CompileContextOptions,
): ModelItem[] => {
    const items: ModelItem[] = [];

    const includePolicy = options?.includePolicy ?? true;
    const policyText = options?.policy ?? AGENT_POLICY;

    const alreadyHasPolicy = transcript.some(
        (item) => item.type === "system" && item.content.includes("Repository behavior:"),
    );

    if (includePolicy && !alreadyHasPolicy) {
        items.push({
            type: "message",
            role: "system",
            content: policyText,
        });
    }

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
                        content:
                            "[Previous assistant generation was interrupted before completion]",
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
                const milestone = item.milestone ?? normalizeLegacyToolExecutionToMilestone(item);
                items.push(formatMilestoneAsModelItem(milestone));
                break;
            }
        }
    }

    return items;
};
