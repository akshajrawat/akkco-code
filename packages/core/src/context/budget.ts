import type { ModelProfile } from "@akkco/models";

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

    /**
     * Explicit flag indicating maximumMemoryTokens is an enforceable hard ceiling rather than a default soft target.
     */
    isHardMemoryLimit?: boolean;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
    preferredInputTokens: 8192,
    reservedOverheadTokens: 1024,
    minimumRecentHistoryTokens: 1536,
    maximumMemoryTokens: 2048,
    maximumRepositoryTokens: 2048,
    isHardMemoryLimit: false,
};

/**
 * Validates that context budget numbers are positive, non-negative, and properly ordered,
 * ensuring preferred tokens exceed reserved overhead.
 */
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

/**
 * Calculate the authoritative maximum input tokens for a ModelProfile:
 * maxInputTokens = contextWindowTokens - maxOutputTokens - safetyMarginTokens
 */
export const calculateMaxInputTokens = (profile: ModelProfile): number => {
    const safetyMargin = profile.safetyMarginTokens ?? 0;
    const maxInputTokens = profile.contextWindowTokens - profile.maxOutputTokens - safetyMargin;
    return maxInputTokens;
};

/**
 * Derive a ContextBudget from a ModelProfile for context compilation.
 * Avoids double-counting safety margins by mapping the profile's derived input
 * capacity into preferredInputTokens while maintaining proportional recent history
 * and memory ceilings.
 */
export const deriveContextBudget = (
    profile: ModelProfile,
    overrides?: Partial<ContextBudget>,
): ContextBudget => {
    const maxInputTokens = calculateMaxInputTokens(profile);
    const reservedOverheadTokens = overrides?.reservedOverheadTokens ?? 0;

    const minimumRecentHistoryTokens =
        overrides?.minimumRecentHistoryTokens ?? Math.floor(maxInputTokens * 0.25);

    const maximumMemoryTokens = overrides?.maximumMemoryTokens ?? Math.floor(maxInputTokens * 0.3);

    const maximumRepositoryTokens =
        overrides?.maximumRepositoryTokens ?? Math.floor(maxInputTokens * 0.3);

    const isHardMemoryLimit =
        overrides?.isHardMemoryLimit ?? overrides?.maximumMemoryTokens !== undefined;

    const budget: ContextBudget = {
        preferredInputTokens: overrides?.preferredInputTokens ?? maxInputTokens,
        reservedOverheadTokens,
        minimumRecentHistoryTokens,
        maximumMemoryTokens,
        maximumRepositoryTokens,
        isHardMemoryLimit,
    };

    validateContextBudget(budget);
    return budget;
};
