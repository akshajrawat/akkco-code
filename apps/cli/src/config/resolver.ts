import { resolveModelProfile, type ModelProfile } from "@akkco/models";
import { applyCredentialsToEnv, loadCredentialsFile } from "./credentials.js";
import { extractEnvConfig, EmbeddingConfigurationError, parseEmbeddingDimensions } from "./env.js";
import { loadConfigFile } from "./loader.js";
import { mergeConfig } from "./merge.js";
import { resolveConfigPaths, type PathResolutionOptions } from "./paths.js";
import type {
    ConfigPaths,
    EffectiveConfig,
    EffectiveEmbeddingConfig,
    EffectiveModelConfig,
    ResolvedConfigResult,
} from "./types.js";

export const DEFAULT_MODEL = "qwen2.5-coder:7b";

export interface ResolveConfigOptions extends PathResolutionOptions {
    readonly cliOverrides?: Partial<EffectiveConfig>;
    readonly globalConfigPath?: string;
    readonly projectConfigPath?: string;
    readonly credentialsPath?: string;
    readonly skipCredentials?: boolean;
}

export const resolveCliModelProfile = (
    modelId: string,
    overrides?: Partial<ModelProfile>,
): ModelProfile => {
    return resolveModelProfile(modelId, overrides);
};

/**
 * Resolves the complete effective configuration for AKKCO Code.
 * Handles paths, credentials loading, global config, project config,
 * environment variable overrides, CLI overrides, and model profile resolution.
 */
export const resolveConfig = async (
    options?: ResolveConfigOptions,
): Promise<ResolvedConfigResult> => {
    const env: NodeJS.ProcessEnv = { ...(options?.env ?? process.env) };
    const paths: ConfigPaths = resolveConfigPaths({
        ...options,
        env,
    });

    const globalConfigPath = options?.globalConfigPath ?? paths.globalConfig;
    const projectConfigPath = options?.projectConfigPath ?? paths.projectConfig;
    const credentialsPath = options?.credentialsPath ?? paths.credentialsFile;

    // 1. Load private credentials into env if not skipped
    let credentialsExists = false;
    if (!options?.skipCredentials && credentialsPath) {
        const credsResult = await loadCredentialsFile(credentialsPath);
        credentialsExists = credsResult.exists;
        if (credsResult.exists) {
            applyCredentialsToEnv(credsResult.credentials, env);
        }
    }

    // 2. Load global configuration
    const globalResult = globalConfigPath
        ? await loadConfigFile(globalConfigPath, { isProject: false })
        : { config: {}, exists: false };

    // 3. Load project configuration
    const projectResult = projectConfigPath
        ? await loadConfigFile(projectConfigPath, { isProject: true })
        : { config: {}, exists: false };

    // 4. Extract environment overrides
    const envConfig = extractEnvConfig(env);

    // 5. Merge all layers
    const { effectiveConfig, sources } = mergeConfig({
        globalConfig: globalResult.config,
        projectConfig: projectResult.config,
        envConfig,
        cliOverrides: options?.cliOverrides,
    });

    // 6. Resolve model profile with effective context window & settings
    const effectiveProfile = resolveCliModelProfile(effectiveConfig.model.name, {
        toolMode: effectiveConfig.model.tool_mode,
        contextWindowTokens: effectiveConfig.context.window_tokens,
        maxOutputTokens: effectiveConfig.context.max_output_tokens,
        safetyMarginTokens: effectiveConfig.context.safety_margin_tokens,
        charsPerToken: effectiveConfig.context.chars_per_token,
    });

    return {
        config: effectiveConfig,
        paths,
        profile: effectiveProfile,
        env,
        sources,
        loadedFiles: {
            globalExists: globalResult.exists,
            projectExists: projectResult.exists,
            credentialsExists,
        },
    };
};

export interface ResolveEmbeddingProviderOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly config?: EffectiveEmbeddingConfig;
    readonly modelConfig?: EffectiveModelConfig;
    readonly fetch?: typeof globalThis.fetch;
}

/**
 * Resolves and instantiates the configured embedding provider based on the
 * effective configuration and environment variables.
 */
export const resolveEmbeddingProvider = async (
    options?: ResolveEmbeddingProviderOptions,
): Promise<import("@akkco/models").EmbeddingProvider | undefined> => {
    const env = options?.env ?? process.env;

    if (env.AKKCO_TEST_PROVIDER) {
        const { DeterministicFakeEmbeddingProvider } = await import("@akkco/models/testing");
        return new DeterministicFakeEmbeddingProvider();
    }

    const cfg = options?.config;
    const envEmbedding = extractEnvConfig(env).embedding;

    // Config file takes precedence over environment variables; env is fallback
    const rawProvider = cfg?.provider ?? envEmbedding?.provider;
    const rawModel = cfg?.model ?? envEmbedding?.model;
    const rawDimensions = cfg?.dimensions ?? envEmbedding?.dimensions;
    const rawBaseUrl = cfg?.base_url ?? envEmbedding?.base_url;
    const rawApiKey = cfg?.api_key ?? envEmbedding?.api_key;

    if (!rawProvider) {
        if (!rawModel) {
            return undefined;
        }
        // Local embedding backward-compatibility when only model is configured
        const { OpenAICompatibleEmbeddingProvider } = await import("@akkco/providers");
        return new OpenAICompatibleEmbeddingProvider({
            baseUrl:
                rawBaseUrl ??
                options?.modelConfig?.base_url ??
                env.AKKCO_BASE_URL ??
                "http://localhost:11434/v1",
            model: rawModel,
            apiKey: rawApiKey ?? env.AKKCO_API_KEY,
            dimensions: rawDimensions,
        });
    }

    if (rawProvider !== "gemini" && rawProvider !== "openai-compatible") {
        throw new EmbeddingConfigurationError(
            `Invalid AKKCO_EMBEDDING_PROVIDER: "${rawProvider}". Supported values are "gemini" and "openai-compatible".`,
        );
    }

    if (rawProvider === "gemini") {
        const apiKeyEnvName = cfg?.api_key_env || "GEMINI_API_KEY";
        const apiKey = (
            env[apiKeyEnvName] ??
            env.GEMINI_API_KEY ??
            env.AKKCO_EMBEDDING_API_KEY ??
            rawApiKey
        )?.trim();

        if (!apiKey) {
            throw new EmbeddingConfigurationError(
                "GEMINI_API_KEY environment variable is required when AKKCO_EMBEDDING_PROVIDER=gemini",
            );
        }

        const model = rawModel || "gemini-embedding-001";
        const dimensions = rawDimensions ?? 768;

        const { GeminiEmbeddingProvider } = await import("@akkco/providers");
        return new GeminiEmbeddingProvider({
            apiKey,
            model,
            dimensions,
            baseUrl: rawBaseUrl,
            fetch: options?.fetch,
        });
    }

    // rawProvider === "openai-compatible"
    const { OpenAICompatibleEmbeddingProvider } = await import("@akkco/providers");
    const model = rawModel || "nomic-embed-text";
    return new OpenAICompatibleEmbeddingProvider({
        baseUrl:
            rawBaseUrl ??
            options?.modelConfig?.base_url ??
            env.AKKCO_BASE_URL ??
            "http://localhost:11434/v1",
        model,
        apiKey: rawApiKey ?? env.AKKCO_API_KEY,
        dimensions: rawDimensions,
    });
};
