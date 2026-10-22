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

export class EmbeddingConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EmbeddingConfigurationError";
    }
}

export interface ResolveEmbeddingProviderOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetch?: typeof globalThis.fetch;
}

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

/**
 * Resolves and instantiates the configured embedding provider based on environment variables,
 * enforcing strict validation for cloud credentials and dimensionality.
 */
export const resolveEmbeddingProvider = async (
    options?: ResolveEmbeddingProviderOptions,
): Promise<import("@akkco/models").EmbeddingProvider | undefined> => {
    const env = options?.env ?? process.env;

    if (env.AKKCO_TEST_PROVIDER) {
        const { DeterministicFakeEmbeddingProvider } = await import("@akkco/models/testing");
        return new DeterministicFakeEmbeddingProvider();
    }

    const rawProvider = env.AKKCO_EMBEDDING_PROVIDER?.trim();
    const rawModel = env.AKKCO_EMBEDDING_MODEL?.trim();

    if (!rawProvider) {
        if (!rawModel) {
            return undefined;
        }
        // Local embedding backward-compatibility when only AKKCO_EMBEDDING_MODEL is set
        const { OpenAICompatibleEmbeddingProvider } = await import("@akkco/providers");
        const dimensions = parseEmbeddingDimensions(env.AKKCO_EMBEDDING_DIMENSIONS);
        return new OpenAICompatibleEmbeddingProvider({
            baseUrl:
                env.AKKCO_EMBEDDING_BASE_URL ?? env.AKKCO_BASE_URL ?? "http://localhost:11434/v1",
            model: rawModel,
            apiKey: env.AKKCO_EMBEDDING_API_KEY ?? env.AKKCO_API_KEY,
            dimensions,
        });
    }

    if (rawProvider !== "gemini" && rawProvider !== "openai-compatible") {
        throw new EmbeddingConfigurationError(
            `Invalid AKKCO_EMBEDDING_PROVIDER: "${rawProvider}". Supported values are "gemini" and "openai-compatible".`,
        );
    }

    if (rawProvider === "gemini") {
        const apiKey = (env.GEMINI_API_KEY ?? env.AKKCO_EMBEDDING_API_KEY)?.trim();
        if (!apiKey) {
            throw new EmbeddingConfigurationError(
                "GEMINI_API_KEY environment variable is required when AKKCO_EMBEDDING_PROVIDER=gemini",
            );
        }
        const model = rawModel || "gemini-embedding-001";
        const parsedDim = parseEmbeddingDimensions(env.AKKCO_EMBEDDING_DIMENSIONS);
        const dimensions = parsedDim ?? 768;

        const { GeminiEmbeddingProvider } = await import("@akkco/providers");
        return new GeminiEmbeddingProvider({
            apiKey,
            model,
            dimensions,
            baseUrl: env.AKKCO_EMBEDDING_BASE_URL,
            fetch: options?.fetch,
        });
    }

    // rawProvider === "openai-compatible"
    const { OpenAICompatibleEmbeddingProvider } = await import("@akkco/providers");
    const model = rawModel || "nomic-embed-text";
    const dimensions = parseEmbeddingDimensions(env.AKKCO_EMBEDDING_DIMENSIONS);
    return new OpenAICompatibleEmbeddingProvider({
        baseUrl: env.AKKCO_EMBEDDING_BASE_URL ?? env.AKKCO_BASE_URL ?? "http://localhost:11434/v1",
        model,
        apiKey: env.AKKCO_EMBEDDING_API_KEY ?? env.AKKCO_API_KEY,
        dimensions,
    });
};
