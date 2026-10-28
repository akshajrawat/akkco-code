import type {
    AkkcoConfig,
    ConfigSource,
    EffectiveConfig,
    ModelConfig,
    ContextConfig,
    EmbeddingConfig,
    AgentConfig,
} from "./types.js";

export const BUILTIN_DEFAULTS: EffectiveConfig = {
    model: {
        name: "qwen2.5-coder:7b",
        provider: "openai-compatible",
        base_url: "http://localhost:11434/v1",
        tool_mode: "compatibility",
    },
    context: {},
    agent: {},
};

export interface MergeInput {
    readonly globalConfig?: AkkcoConfig;
    readonly projectConfig?: AkkcoConfig;
    readonly envConfig?: AkkcoConfig;
    readonly cliOverrides?: Partial<EffectiveConfig>;
}

export interface MergeResult {
    readonly effectiveConfig: EffectiveConfig;
    readonly sources: Record<string, ConfigSource>;
}

/**
 * Merges configuration layers in deterministic precedence order:
 * 1. Built-in defaults (lowest)
 * 2. Environment variables as fallback for settings not specified in configuration files
 * 3. Global config.toml
 * 4. Project .akkco/config.toml (allowlisted fields only)
 * 5. CLI overrides (highest)
 */
export const mergeConfig = (input: MergeInput): MergeResult => {
    const sources: Record<string, ConfigSource> = {};

    // 1. Start with built-in defaults
    const model: EffectiveConfig["model"] = { ...BUILTIN_DEFAULTS.model };
    sources["model.name"] = "default";
    sources["model.provider"] = "default";
    sources["model.base_url"] = "default";
    sources["model.tool_mode"] = "default";

    const context: EffectiveConfig["context"] = {};
    const agent: EffectiveConfig["agent"] = {};
    let embedding: EffectiveConfig["embedding"] | undefined;

    // Helper to apply layer
    const applyModel = (layer: ModelConfig | undefined, source: ConfigSource) => {
        if (!layer) return;
        if (layer.name !== undefined) {
            model.name = layer.name;
            sources["model.name"] = source;
        }
        if (layer.provider !== undefined) {
            model.provider = layer.provider;
            sources["model.provider"] = source;
        }
        if (layer.base_url !== undefined) {
            model.base_url = layer.base_url;
            sources["model.base_url"] = source;
        }
        if (layer.api_key !== undefined) {
            model.api_key = layer.api_key;
            sources["model.api_key"] = source;
        }
        if (layer.tool_mode !== undefined) {
            model.tool_mode = layer.tool_mode;
            sources["model.tool_mode"] = source;
        }
    };

    const applyContext = (layer: ContextConfig | undefined, source: ConfigSource) => {
        if (!layer) return;
        if (layer.window_tokens !== undefined) {
            context.window_tokens = layer.window_tokens;
            sources["context.window_tokens"] = source;
        }
        if (layer.max_output_tokens !== undefined) {
            context.max_output_tokens = layer.max_output_tokens;
            sources["context.max_output_tokens"] = source;
        }
        if (layer.safety_margin_tokens !== undefined) {
            context.safety_margin_tokens = layer.safety_margin_tokens;
            sources["context.safety_margin_tokens"] = source;
        }
        if (layer.chars_per_token !== undefined) {
            context.chars_per_token = layer.chars_per_token;
            sources["context.chars_per_token"] = source;
        }
    };

    const applyAgent = (layer: AgentConfig | undefined, source: ConfigSource) => {
        if (!layer) return;
        if (layer.max_tool_iterations !== undefined) {
            agent.max_tool_iterations = layer.max_tool_iterations;
            sources["agent.max_tool_iterations"] = source;
        }
        if (layer.repeated_tool_call_limit !== undefined) {
            agent.repeated_tool_call_limit = layer.repeated_tool_call_limit;
            sources["agent.repeated_tool_call_limit"] = source;
        }
        if (layer.consecutive_tool_error_limit !== undefined) {
            agent.consecutive_tool_error_limit = layer.consecutive_tool_error_limit;
            sources["agent.consecutive_tool_error_limit"] = source;
        }
    };

    const applyEmbedding = (layer: EmbeddingConfig | undefined, source: ConfigSource) => {
        if (!layer) return;
        if (
            !embedding &&
            (layer.provider !== undefined ||
                layer.model !== undefined ||
                layer.dimensions !== undefined ||
                layer.base_url !== undefined)
        ) {
            embedding = {};
        }
        if (!embedding) return;

        if (layer.provider !== undefined) {
            embedding.provider = layer.provider;
            sources["embedding.provider"] = source;
        }
        if (layer.model !== undefined) {
            embedding.model = layer.model;
            sources["embedding.model"] = source;
        }
        if (layer.dimensions !== undefined) {
            embedding.dimensions = layer.dimensions;
            sources["embedding.dimensions"] = source;
        }
        if (layer.api_key_env !== undefined) {
            embedding.api_key_env = layer.api_key_env;
            sources["embedding.api_key_env"] = source;
        }
        if (layer.api_key !== undefined) {
            embedding.api_key = layer.api_key;
            sources["embedding.api_key"] = source;
        }
        if (layer.base_url !== undefined) {
            embedding.base_url = layer.base_url;
            sources["embedding.base_url"] = source;
        }
    };

    // 2. Environment variables (fallback for settings not in configuration files)
    applyModel(input.envConfig?.model, "env");
    applyContext(input.envConfig?.context, "env");
    applyEmbedding(input.envConfig?.embedding, "env");
    applyAgent(input.envConfig?.agent, "env");

    // 3. Global configuration (overrides env fallback and defaults)
    applyModel(input.globalConfig?.model, "global");
    applyContext(input.globalConfig?.context, "global");
    applyEmbedding(input.globalConfig?.embedding, "global");
    applyAgent(input.globalConfig?.agent, "global");

    // 4. Project configuration (allowlisted fields only, overrides global and env)
    if (input.projectConfig) {
        // Project config validation already ensured only allowlisted fields exist
        applyModel(input.projectConfig.model, "project");
        applyContext(input.projectConfig.context, "project");
        applyEmbedding(input.projectConfig.embedding, "project");
        applyAgent(input.projectConfig.agent, "project");
    }

    // 5. CLI overrides
    if (input.cliOverrides) {
        if (input.cliOverrides.model) {
            applyModel(input.cliOverrides.model, "cli");
        }
        if (input.cliOverrides.context) {
            applyContext(input.cliOverrides.context, "cli");
        }
        if (input.cliOverrides.embedding) {
            applyEmbedding(input.cliOverrides.embedding, "cli");
        }
        if (input.cliOverrides.agent) {
            applyAgent(input.cliOverrides.agent, "cli");
        }
    }

    const effectiveConfig: EffectiveConfig = {
        model,
        context,
        embedding,
        agent,
    };

    return { effectiveConfig, sources };
};
