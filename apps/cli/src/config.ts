import { resolveModelProfile, type ModelProfile } from "@akkco/models";

export type ToolMode = "native" | "compatibility";

export const DEFAULT_MODEL = "qwen2.5-coder:7b";

export const parseToolMode = (envValue?: string): ToolMode => {
    if (envValue === undefined) {
        return "compatibility";
    }
    if (envValue === "native" || envValue === "compatibility") {
        return envValue;
    }
    throw new Error(
        `Invalid AKKCO_TOOL_MODE: "${envValue}". Supported values are "native" and "compatibility".`,
    );
};

export const parseMaxToolIterations = (envValue?: string): number | undefined => {
    if (envValue === undefined) {
        return undefined;
    }
    const trimmed = envValue.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
            `Invalid AKKCO_MAX_TOOL_ITERATIONS: "${envValue}". Must be a finite positive integer.`,
        );
    }
    return parsed;
};

export const parseContextWindowTokens = (envValue?: string): number | undefined => {
    if (envValue === undefined) {
        return undefined;
    }
    const trimmed = envValue.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
            `Invalid AKKCO_CONTEXT_WINDOW_TOKENS: "${envValue}". Must be a finite positive integer.`,
        );
    }
    return parsed;
};

export const parseMaxOutputTokens = (envValue?: string): number | undefined => {
    if (envValue === undefined) {
        return undefined;
    }
    const trimmed = envValue.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
            `Invalid AKKCO_MAX_OUTPUT_TOKENS: "${envValue}". Must be a finite positive integer.`,
        );
    }
    return parsed;
};

export const parseSafetyMarginTokens = (envValue?: string): number | undefined => {
    if (envValue === undefined) {
        return undefined;
    }
    const trimmed = envValue.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isInteger(parsed) || parsed < 0) {
        throw new Error(
            `Invalid AKKCO_SAFETY_MARGIN_TOKENS: "${envValue}". Must be a finite non-negative integer.`,
        );
    }
    return parsed;
};

export const parseCharsPerToken = (envValue?: string): number | undefined => {
    if (envValue === undefined) {
        return undefined;
    }
    const trimmed = envValue.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
            `Invalid AKKCO_CHARS_PER_TOKEN: "${envValue}". Must be a positive finite number.`,
        );
    }
    return parsed;
};

export const resolveCliModelProfile = (
    modelId: string,
    overrides?: Partial<ModelProfile>,
): ModelProfile => {
    return resolveModelProfile(modelId, overrides);
};
