import type { ToolExecutionTranscriptItem, TranscriptItem } from "../transcript/types.js";

export interface DerivedMemoryDocument {
    readonly startSequence: number;
    readonly endSequence: number;
    readonly content: string;
}

const formatToolActivity = (item: ToolExecutionTranscriptItem): string => {
    const args =
        item.arguments && typeof item.arguments === "object"
            ? (item.arguments as Record<string, unknown>)
            : {};

    switch (item.toolName) {
        case "read_file": {
            const path = typeof args.path === "string" ? args.path : JSON.stringify(args);
            return `read ${path}`;
        }
        case "search_text": {
            const query = typeof args.query === "string" ? args.query : JSON.stringify(args);
            return `searched "${query}"`;
        }
        case "list_files": {
            const path = typeof args.path === "string" ? args.path : ".";
            return `listed files in ${path}`;
        }
        default: {
            const argsStr = JSON.stringify(item.arguments ?? {});
            const conciseArgs = argsStr.length > 120 ? `${argsStr.slice(0, 117)}...` : argsStr;
            return `${item.toolName} ${conciseArgs}`;
        }
    }
};

/**
 * Derives a searchable memory document from a completed conversational turn,
 * capturing user intent, concise tool summaries, and the final completed assistant answer.
 */
export const createMemoryDocumentFromTurn = (
    turnItems: readonly TranscriptItem[],
    startSequence: number,
    endSequence: number,
): DerivedMemoryDocument | null => {
    if (turnItems.length === 0) {
        return null;
    }

    const userItem = turnItems.find((item) => item.type === "user");
    if (!userItem || userItem.type !== "user") {
        return null;
    }

    const assistantItems = turnItems.filter((item) => item.type === "assistant");
    const lastAssistant = assistantItems.at(-1);

    // Intentionally omit turns that failed or were interrupted before completion
    if (!lastAssistant || lastAssistant.status !== "completed") {
        return null;
    }

    const toolItems = turnItems.filter(
        (item): item is ToolExecutionTranscriptItem => item.type === "tool_execution",
    );

    const parts: string[] = [`User: ${userItem.content}`];

    if (toolItems.length > 0) {
        parts.push("Tool Activity:");
        for (const tool of toolItems) {
            parts.push(`- ${formatToolActivity(tool)}`);
        }
    }

    // Include the final completed assistant answer
    if (lastAssistant.content.trim().length > 0) {
        parts.push(`Assistant: ${lastAssistant.content}`);
    }

    const content = parts.join("\n");

    return {
        startSequence,
        endSequence,
        content,
    };
};

/**
 * Partitions a conversation transcript into completed turns and derives
 * structured memory documents suitable for vector indexing.
 */
export const deriveMemoryDocumentsFromTranscript = (
    transcript: readonly TranscriptItem[],
): DerivedMemoryDocument[] => {
    const docs: DerivedMemoryDocument[] = [];
    let currentTurnStartIndex: number | null = null;
    let currentTurnItems: TranscriptItem[] = [];

    for (let i = 0; i < transcript.length; i++) {
        const item = transcript[i];

        if (item.type === "user") {
            if (currentTurnStartIndex !== null && currentTurnItems.length > 0) {
                const doc = createMemoryDocumentFromTurn(
                    currentTurnItems,
                    currentTurnStartIndex,
                    i - 1,
                );
                if (doc) {
                    docs.push(doc);
                }
            }

            currentTurnStartIndex = i;
            currentTurnItems = [item];
        } else if (currentTurnStartIndex !== null) {
            currentTurnItems.push(item);
        }
    }

    if (currentTurnStartIndex !== null && currentTurnItems.length > 0) {
        const doc = createMemoryDocumentFromTurn(
            currentTurnItems,
            currentTurnStartIndex,
            transcript.length - 1,
        );
        if (doc) {
            docs.push(doc);
        }
    }

    return docs;
};
