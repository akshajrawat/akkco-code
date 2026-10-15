export interface ContextBudget {
    /**
     * Target upper bound on tokens for the model request input.
     */
    preferredInputTokens: number;

    /**
     * Capacity reserved for provider framing, system instructions, tool definitions, and safety margin.
     */
    reservedOverheadTokens: number;

    /**
     * Minimum token capacity prioritized for recent conversational history continuity.
     */
    minimumRecentHistoryTokens: number;

    /**
     * Dynamic ceiling (not a fixed quota) for retrieved historical conversation memory.
     */
    maximumMemoryTokens?: number;

    /**
     * Dynamic ceiling (not a fixed quota) reserved for repository evidence (Task 2).
     */
    maximumRepositoryTokens?: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
    preferredInputTokens: 8192,
    reservedOverheadTokens: 1024,
    minimumRecentHistoryTokens: 1536,
    maximumMemoryTokens: 2048,
    maximumRepositoryTokens: 2048,
};

export const validateContextBudget = (
    budget: ContextBudget,
    maxToolOutputTokens?: number,
): void => {
    if (!budget || typeof budget !== "object") {
        throw new TypeError("Invalid context budget: budget must be an object");
    }

    if (
        typeof budget.preferredInputTokens !== "number" ||
        Number.isNaN(budget.preferredInputTokens) ||
        !Number.isFinite(budget.preferredInputTokens) ||
        !Number.isInteger(budget.preferredInputTokens) ||
        budget.preferredInputTokens <= 0
    ) {
        throw new RangeError(
            `Invalid context budget: preferredInputTokens must be a positive integer, received ${budget.preferredInputTokens}`,
        );
    }

    if (
        typeof budget.reservedOverheadTokens !== "number" ||
        Number.isNaN(budget.reservedOverheadTokens) ||
        !Number.isFinite(budget.reservedOverheadTokens) ||
        !Number.isInteger(budget.reservedOverheadTokens) ||
        budget.reservedOverheadTokens < 0
    ) {
        throw new RangeError(
            `Invalid context budget: reservedOverheadTokens must be a non-negative integer, received ${budget.reservedOverheadTokens}`,
        );
    }

    if (
        typeof budget.minimumRecentHistoryTokens !== "number" ||
        Number.isNaN(budget.minimumRecentHistoryTokens) ||
        !Number.isFinite(budget.minimumRecentHistoryTokens) ||
        !Number.isInteger(budget.minimumRecentHistoryTokens) ||
        budget.minimumRecentHistoryTokens < 0
    ) {
        throw new RangeError(
            `Invalid context budget: minimumRecentHistoryTokens must be a non-negative integer, received ${budget.minimumRecentHistoryTokens}`,
        );
    }

    if (budget.maximumMemoryTokens !== undefined) {
        if (
            typeof budget.maximumMemoryTokens !== "number" ||
            Number.isNaN(budget.maximumMemoryTokens) ||
            !Number.isFinite(budget.maximumMemoryTokens) ||
            !Number.isInteger(budget.maximumMemoryTokens) ||
            budget.maximumMemoryTokens < 0
        ) {
            throw new RangeError(
                `Invalid context budget: maximumMemoryTokens must be a non-negative integer, received ${budget.maximumMemoryTokens}`,
            );
        }
    }

    if (budget.maximumRepositoryTokens !== undefined) {
        if (
            typeof budget.maximumRepositoryTokens !== "number" ||
            Number.isNaN(budget.maximumRepositoryTokens) ||
            !Number.isFinite(budget.maximumRepositoryTokens) ||
            !Number.isInteger(budget.maximumRepositoryTokens) ||
            budget.maximumRepositoryTokens < 0
        ) {
            throw new RangeError(
                `Invalid context budget: maximumRepositoryTokens must be a non-negative integer, received ${budget.maximumRepositoryTokens}`,
            );
        }
    }

    if (maxToolOutputTokens !== undefined) {
        if (
            typeof maxToolOutputTokens !== "number" ||
            Number.isNaN(maxToolOutputTokens) ||
            !Number.isFinite(maxToolOutputTokens) ||
            !Number.isInteger(maxToolOutputTokens) ||
            maxToolOutputTokens <= 0
        ) {
            throw new RangeError(
                `Invalid context budget: maxToolOutputTokens must be a positive integer, received ${maxToolOutputTokens}`,
            );
        }
    }

    if (budget.preferredInputTokens <= budget.reservedOverheadTokens) {
        throw new RangeError(
            `Invalid context budget: preferredInputTokens (${budget.preferredInputTokens}) must be greater than reservedOverheadTokens (${budget.reservedOverheadTokens}) to leave space for mandatory input.`,
        );
    }
};
