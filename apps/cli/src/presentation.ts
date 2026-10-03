import type { ToolExecutionState } from "./state/types.js";

export const toolStatusLabel = (execution: ToolExecutionState) => {
    const duration = execution.durationMs === undefined ? "" : ` (${execution.durationMs}ms)`;

    switch (execution.status) {
        case "running":
            return "◌ running...";

        case "completed":
            return `✔ completed${duration}`;

        case "failed":
            return `✖ failed${duration}`;

        case "cancelled":
            return "⊘ cancelled";
    }
};

export const toolArguments = (input: unknown) => {
    return JSON.stringify(input) ?? "null";
};
