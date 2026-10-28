import type { ModelProfile } from "@akkco/models";

export type ToolMode = "native" | "compatibility";
export type EmbeddingProviderType = "gemini" | "openai-compatible";

export interface ModelConfig {
    name?: string;
    provider?: string;
    base_url?: string;
    api_key?: string;
    tool_mode?: ToolMode;
}

export interface ContextConfig {
    window_tokens?: number;
    max_output_tokens?: number;
    safety_margin_tokens?: number;
    chars_per_token?: number;
}

export interface EmbeddingConfig {
    provider?: EmbeddingProviderType;
    model?: string;
    dimensions?: number;
    api_key_env?: string;
    api_key?: string;
    base_url?: string;
}

export interface AgentConfig {
    max_tool_iterations?: number;
    repeated_tool_call_limit?: number;
    consecutive_tool_error_limit?: number;
}

export interface AkkcoConfig {
    model?: ModelConfig;
    context?: ContextConfig;
    embedding?: EmbeddingConfig;
    agent?: AgentConfig;
}

export interface EffectiveModelConfig {
    name: string;
    provider: string;
    base_url: string;
    api_key?: string;
    tool_mode: ToolMode;
}

export interface EffectiveContextConfig {
    window_tokens?: number;
    max_output_tokens?: number;
    safety_margin_tokens?: number;
    chars_per_token?: number;
}

export interface EffectiveEmbeddingConfig {
    provider?: EmbeddingProviderType;
    model?: string;
    dimensions?: number;
    api_key_env?: string;
    api_key?: string;
    base_url?: string;
}

export interface EffectiveAgentConfig {
    max_tool_iterations?: number;
    repeated_tool_call_limit?: number;
    consecutive_tool_error_limit?: number;
}

export interface EffectiveConfig {
    model: EffectiveModelConfig;
    context: EffectiveContextConfig;
    embedding?: EffectiveEmbeddingConfig;
    agent: EffectiveAgentConfig;
}

export interface ConfigPaths {
    globalDir: string;
    globalConfig: string;
    credentialsFile: string;
    repoRoot?: string;
    projectDir?: string;
    projectConfig?: string;
}

export type ConfigSource = "default" | "global" | "project" | "env" | "cli";

export interface ResolvedConfigResult {
    config: EffectiveConfig;
    paths: ConfigPaths;
    profile: ModelProfile;
    env: NodeJS.ProcessEnv;
    sources: Record<string, ConfigSource>;
    loadedFiles: {
        globalExists: boolean;
        projectExists: boolean;
        credentialsExists: boolean;
    };
}
