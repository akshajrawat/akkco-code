import type { ModelProfile } from "./contracts/profile.js";

const BASELINE_PROFILE: Omit<ModelProfile, "id"> = {
    contextWindowTokens: 8192,
    maxOutputTokens: 1024,
    safetyMarginTokens: 256,
    toolMode: "compatibility",
    charsPerToken: 4,
};

const getModelPreset = (modelId: string): Partial<ModelProfile> | undefined => {
    const normalized = modelId.toLowerCase().trim();
    if (normalized.startsWith("qwen2.5-coder") || normalized.startsWith("qwen2.5_coder")) {
        return {
            contextWindowTokens: 32768,
            maxOutputTokens: 2048,
            safetyMarginTokens: 512,
            toolMode: "compatibility",
            charsPerToken: 4,
        };
    }
    if (
        normalized.startsWith("llama3.1") ||
        normalized.startsWith("llama-3.1") ||
        normalized.startsWith("llama3.2") ||
        normalized.startsWith("llama-3.2")
    ) {
        return {
            contextWindowTokens: 32768,
            maxOutputTokens: 2048,
            safetyMarginTokens: 512,
            toolMode: "compatibility",
            charsPerToken: 4,
        };
    }
    if (normalized.startsWith("llama3") || normalized.startsWith("llama-3")) {
        return {
            contextWindowTokens: 8192,
            maxOutputTokens: 1024,
            safetyMarginTokens: 256,
            toolMode: "compatibility",
            charsPerToken: 4,
        };
    }
    return undefined;
};

/**
 * Validates structural limits and invariants of a model profile, ensuring
 * positive token dimensions and non-zero effective input capacity.
 */
export const validateModelProfile = (profile: ModelProfile): void => {
    if (!profile || typeof profile !== "object") {
        throw new TypeError("Model profile must be an object");
    }

    if (typeof profile.id !== "string" || profile.id.trim() === "") {
        throw new TypeError("Model profile id must be a non-empty string");
    }

    if (
        typeof profile.contextWindowTokens !== "number" ||
        !Number.isFinite(profile.contextWindowTokens) ||
        !Number.isInteger(profile.contextWindowTokens) ||
        profile.contextWindowTokens <= 0
    ) {
        throw new RangeError(
            `contextWindowTokens must be a positive integer, received ${profile.contextWindowTokens}`,
        );
    }

    if (
        typeof profile.maxOutputTokens !== "number" ||
        !Number.isFinite(profile.maxOutputTokens) ||
        !Number.isInteger(profile.maxOutputTokens) ||
        profile.maxOutputTokens <= 0
    ) {
        throw new RangeError(
            `maxOutputTokens must be a positive integer, received ${profile.maxOutputTokens}`,
        );
    }

    if (profile.safetyMarginTokens !== undefined) {
        if (
            typeof profile.safetyMarginTokens !== "number" ||
            !Number.isFinite(profile.safetyMarginTokens) ||
            !Number.isInteger(profile.safetyMarginTokens) ||
            profile.safetyMarginTokens < 0
        ) {
            throw new RangeError(
                `safetyMarginTokens must be a non-negative integer, received ${profile.safetyMarginTokens}`,
            );
        }
    }

    if (profile.charsPerToken !== undefined) {
        if (
            typeof profile.charsPerToken !== "number" ||
            !Number.isFinite(profile.charsPerToken) ||
            profile.charsPerToken <= 0
        ) {
            throw new RangeError(
                `charsPerToken must be a positive finite number, received ${profile.charsPerToken}`,
            );
        }
    }

    if (profile.toolMode !== "native" && profile.toolMode !== "compatibility") {
        throw new RangeError(
            `toolMode must be "native" or "compatibility", received ${String(profile.toolMode)}`,
        );
    }

    const safetyMargin = profile.safetyMarginTokens ?? 0;
    const effectiveInput = profile.contextWindowTokens - profile.maxOutputTokens - safetyMargin;
    if (effectiveInput <= 0) {
        throw new RangeError(
            `Effective input capacity (${effectiveInput} tokens) must be strictly greater than zero. ` +
                `Context window: ${profile.contextWindowTokens}, max output: ${profile.maxOutputTokens}, safety margin: ${safetyMargin}.`,
        );
    }
};

/**
 * Resolves a model profile using the 3-tier hierarchy: conservative baseline defaults,
 * known model family presets, and explicit user-configured overrides.
 */
export const resolveModelProfile = (
    modelId: string,
    overrides?: Partial<ModelProfile>,
): ModelProfile => {
    if (typeof modelId !== "string" || modelId.trim() === "") {
        throw new TypeError("Model identifier must be a non-empty string");
    }

    const trimmedModelId = modelId.trim();
    const preset = getModelPreset(trimmedModelId);

    const cleanOverrides: Partial<ModelProfile> = {};
    if (overrides && typeof overrides === "object") {
        for (const [key, value] of Object.entries(overrides)) {
            if (value !== undefined) {
                (cleanOverrides as Record<string, unknown>)[key] = value;
            }
        }
    }

    const resolved: ModelProfile = {
        ...BASELINE_PROFILE,
        ...(preset ?? {}),
        ...cleanOverrides,
        id: cleanOverrides.id ? cleanOverrides.id.trim() : trimmedModelId,
    };

    validateModelProfile(resolved);
    return resolved;
};
