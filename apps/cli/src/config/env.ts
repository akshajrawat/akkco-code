import type { ToolMode, EmbeddingProviderType, AkkcoConfig } from "./types.js";

export class EmbeddingConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EmbeddingConfigurationError";
    }
}

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

export const parseRepeatedToolCallLimit = (envValue?: string): number | undefined => {
    if (envValue === undefined) {
        return undefined;
    }
    const trimmed = envValue.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
            `Invalid AKKCO_REPEATED_TOOL_CALL_LIMIT: "${envValue}". Must be a finite positive integer.`,
        );
    }
    return parsed;
};

export const parseConsecutiveToolErrorLimit = (envValue?: string): number | undefined => {
    if (envValue === undefined) {
        return undefined;
    }
    const trimmed = envValue.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
            `Invalid AKKCO_CONSECUTIVE_TOOL_ERROR_LIMIT: "${envValue}". Must be a finite positive integer.`,
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

export const parseEmbeddingDimensions = (envValue?: string): number | undefined => {
    if (envValue === undefined) {
        return undefined;
    }
    const trimmed = envValue.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) {
        throw new EmbeddingConfigurationError(
            `Invalid AKKCO_EMBEDDING_DIMENSIONS: "${envValue}". Must be a positive integer.`,
        );
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new EmbeddingConfigurationError(
            `Invalid AKKCO_EMBEDDING_DIMENSIONS: "${envValue}". Must be a positive integer.`,
        );
    }
    return parsed;
};

export const parseEmbeddingProvider = (envValue?: string): EmbeddingProviderType | undefined => {
    if (envValue === undefined) {
        return undefined;
    }
    const trimmed = envValue.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed !== "gemini" && trimmed !== "openai-compatible") {
        throw new EmbeddingConfigurationError(
            `Invalid AKKCO_EMBEDDING_PROVIDER: "${trimmed}". Supported values are "gemini" and "openai-compatible".`,
        );
    }
    return trimmed;
};

/**
 * Extracts configuration overrides from environment variables.
 */
export const extractEnvConfig = (env: NodeJS.ProcessEnv): AkkcoConfig => {
    const config: AkkcoConfig = {};

    // Model overrides
    if (
        env.AKKCO_MODEL !== undefined ||
        env.AKKCO_BASE_URL !== undefined ||
        env.AKKCO_API_KEY !== undefined ||
        env.AKKCO_TOOL_MODE !== undefined
    ) {
        config.model = {};
        if (env.AKKCO_MODEL !== undefined && env.AKKCO_MODEL.trim() !== "") {
            config.model.name = env.AKKCO_MODEL.trim();
        }
        if (env.AKKCO_BASE_URL !== undefined && env.AKKCO_BASE_URL.trim() !== "") {
            config.model.base_url = env.AKKCO_BASE_URL.trim();
        }
        if (env.AKKCO_API_KEY !== undefined) {
            config.model.api_key = env.AKKCO_API_KEY;
        }
        if (env.AKKCO_TOOL_MODE !== undefined) {
            config.model.tool_mode = parseToolMode(env.AKKCO_TOOL_MODE);
        }
    }

    // Context overrides
    if (
        env.AKKCO_CONTEXT_WINDOW_TOKENS !== undefined ||
        env.AKKCO_MAX_OUTPUT_TOKENS !== undefined ||
        env.AKKCO_SAFETY_MARGIN_TOKENS !== undefined ||
        env.AKKCO_CHARS_PER_TOKEN !== undefined
    ) {
        config.context = {};
        if (env.AKKCO_CONTEXT_WINDOW_TOKENS !== undefined) {
            config.context.window_tokens = parseContextWindowTokens(
                env.AKKCO_CONTEXT_WINDOW_TOKENS,
            );
        }
        if (env.AKKCO_MAX_OUTPUT_TOKENS !== undefined) {
            config.context.max_output_tokens = parseMaxOutputTokens(env.AKKCO_MAX_OUTPUT_TOKENS);
        }
        if (env.AKKCO_SAFETY_MARGIN_TOKENS !== undefined) {
            config.context.safety_margin_tokens = parseSafetyMarginTokens(
                env.AKKCO_SAFETY_MARGIN_TOKENS,
            );
        }
        if (env.AKKCO_CHARS_PER_TOKEN !== undefined) {
            config.context.chars_per_token = parseCharsPerToken(env.AKKCO_CHARS_PER_TOKEN);
        }
    }

    // Agent overrides
    if (
        env.AKKCO_MAX_TOOL_ITERATIONS !== undefined ||
        env.AKKCO_REPEATED_TOOL_CALL_LIMIT !== undefined ||
        env.AKKCO_CONSECUTIVE_TOOL_ERROR_LIMIT !== undefined
    ) {
        config.agent = {};
        if (env.AKKCO_MAX_TOOL_ITERATIONS !== undefined) {
            config.agent.max_tool_iterations = parseMaxToolIterations(
                env.AKKCO_MAX_TOOL_ITERATIONS,
            );
        }
        if (env.AKKCO_REPEATED_TOOL_CALL_LIMIT !== undefined) {
            config.agent.repeated_tool_call_limit = parseRepeatedToolCallLimit(
                env.AKKCO_REPEATED_TOOL_CALL_LIMIT,
            );
        }
        if (env.AKKCO_CONSECUTIVE_TOOL_ERROR_LIMIT !== undefined) {
            config.agent.consecutive_tool_error_limit = parseConsecutiveToolErrorLimit(
                env.AKKCO_CONSECUTIVE_TOOL_ERROR_LIMIT,
            );
        }
    }

    // Embedding overrides
    if (
        env.AKKCO_EMBEDDING_PROVIDER !== undefined ||
        env.AKKCO_EMBEDDING_MODEL !== undefined ||
        env.AKKCO_EMBEDDING_DIMENSIONS !== undefined ||
        env.AKKCO_EMBEDDING_BASE_URL !== undefined ||
        env.AKKCO_EMBEDDING_API_KEY !== undefined
    ) {
        config.embedding = {};
        if (env.AKKCO_EMBEDDING_PROVIDER !== undefined) {
            config.embedding.provider = parseEmbeddingProvider(env.AKKCO_EMBEDDING_PROVIDER);
        }
        if (env.AKKCO_EMBEDDING_MODEL !== undefined && env.AKKCO_EMBEDDING_MODEL.trim() !== "") {
            config.embedding.model = env.AKKCO_EMBEDDING_MODEL.trim();
        }
        if (env.AKKCO_EMBEDDING_DIMENSIONS !== undefined) {
            config.embedding.dimensions = parseEmbeddingDimensions(env.AKKCO_EMBEDDING_DIMENSIONS);
        }
        if (
            env.AKKCO_EMBEDDING_BASE_URL !== undefined &&
            env.AKKCO_EMBEDDING_BASE_URL.trim() !== ""
        ) {
            config.embedding.base_url = env.AKKCO_EMBEDDING_BASE_URL.trim();
        }
        if (env.AKKCO_EMBEDDING_API_KEY !== undefined) {
            config.embedding.api_key = env.AKKCO_EMBEDDING_API_KEY;
        }
    }

    return config;
};
