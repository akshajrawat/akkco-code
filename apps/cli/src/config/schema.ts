import { z } from "zod";
import type { AkkcoConfig } from "./types.js";

export class ConfigValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigValidationError";
    }
}

export class ConfigSecurityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigSecurityError";
    }
}

export const toolModeSchema = z.enum(["native", "compatibility"] as const);

export const modelConfigSchema = z
    .object({
        name: z.string().trim().min(1, "Model name cannot be empty").optional(),
        provider: z.string().trim().min(1, "Model provider cannot be empty").optional(),
        base_url: z.string().trim().min(1, "base_url cannot be empty").optional(),
        api_key: z.string().optional(),
        tool_mode: toolModeSchema.optional(),
    })
    .strict("Unknown field in [model] configuration");

export const contextConfigSchema = z
    .object({
        window_tokens: z
            .number({ invalid_type_error: "window_tokens must be a number" })
            .int("window_tokens must be an integer")
            .positive("window_tokens must be a positive integer")
            .optional(),
        max_output_tokens: z
            .number({ invalid_type_error: "max_output_tokens must be a number" })
            .int("max_output_tokens must be an integer")
            .positive("max_output_tokens must be a positive integer")
            .optional(),
        safety_margin_tokens: z
            .number({ invalid_type_error: "safety_margin_tokens must be a number" })
            .int("safety_margin_tokens must be an integer")
            .min(0, "safety_margin_tokens must be a non-negative integer")
            .optional(),
        chars_per_token: z
            .number({ invalid_type_error: "chars_per_token must be a number" })
            .positive("chars_per_token must be a positive number")
            .optional(),
    })
    .strict("Unknown field in [context] configuration");

export const embeddingProviderSchema = z.enum(["gemini", "openai-compatible"] as const);

export const embeddingConfigSchema = z
    .object({
        provider: embeddingProviderSchema.optional(),
        model: z.string().trim().min(1, "Embedding model cannot be empty").optional(),
        dimensions: z
            .number({ invalid_type_error: "dimensions must be a number" })
            .int("dimensions must be an integer")
            .positive("dimensions must be a positive integer")
            .optional(),
        api_key_env: z.string().trim().min(1, "api_key_env cannot be empty").optional(),
        api_key: z.string().optional(),
        base_url: z.string().trim().min(1, "Embedding base_url cannot be empty").optional(),
    })
    .strict("Unknown field in [embedding] configuration");

export const agentConfigSchema = z
    .object({
        max_tool_iterations: z
            .number({ invalid_type_error: "max_tool_iterations must be a number" })
            .int("max_tool_iterations must be an integer")
            .positive("max_tool_iterations must be a positive integer")
            .optional(),
        repeated_tool_call_limit: z
            .number({ invalid_type_error: "repeated_tool_call_limit must be a number" })
            .int("repeated_tool_call_limit must be an integer")
            .positive("repeated_tool_call_limit must be a positive integer")
            .optional(),
        consecutive_tool_error_limit: z
            .number({ invalid_type_error: "consecutive_tool_error_limit must be a number" })
            .int("consecutive_tool_error_limit must be an integer")
            .positive("consecutive_tool_error_limit must be a positive integer")
            .optional(),
    })
    .strict("Unknown field in [agent] configuration");

export const akkcoConfigSchema = z
    .object({
        model: modelConfigSchema.optional(),
        context: contextConfigSchema.optional(),
        embedding: embeddingConfigSchema.optional(),
        agent: agentConfigSchema.optional(),
    })
    .strict("Unknown section in configuration");

/**
 * Validates a parsed raw configuration object against the Akkco schema.
 */
export const validateConfig = (raw: unknown, sourceName = "configuration"): AkkcoConfig => {
    const result = akkcoConfigSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => {
                const pathStr = issue.path.join(".");
                return pathStr ? `"${pathStr}": ${issue.message}` : issue.message;
            })
            .join("; ");
        throw new ConfigValidationError(`Invalid ${sourceName}: ${issues}`);
    }

    const config = result.data;

    // Validate context invariants if context limits are specified
    if (config.context?.window_tokens && config.context?.max_output_tokens) {
        const margin = config.context.safety_margin_tokens ?? 0;
        const effectiveInput =
            config.context.window_tokens - config.context.max_output_tokens - margin;
        if (effectiveInput <= 0) {
            throw new ConfigValidationError(
                `Invalid ${sourceName}: Effective input capacity (${effectiveInput} tokens) must be strictly greater than zero. ` +
                    `window_tokens: ${config.context.window_tokens}, max_output_tokens: ${config.context.max_output_tokens}, safety_margin: ${margin}.`,
            );
        }
    }

    return config;
};

/**
 * Project configuration allowlist.
 * Specifies settings that are safe to override from an untrusted project configuration.
 */
export const PROJECT_OVERRIDE_ALLOWLIST: ReadonlySet<string> = new Set([
    "model.name",
    "model.tool_mode",
    "context.window_tokens",
    "context.max_output_tokens",
    "context.safety_margin_tokens",
    "context.chars_per_token",
    "embedding.model",
    "embedding.dimensions",
    "agent.max_tool_iterations",
    "agent.repeated_tool_call_limit",
    "agent.consecutive_tool_error_limit",
]);

/**
 * Validates a project configuration, strictly rejecting any security-sensitive
 * settings not included in the project override allowlist.
 */
export const validateProjectConfig = (
    raw: unknown,
    sourcePath = ".akkco/config.toml",
): AkkcoConfig => {
    const config = validateConfig(raw, `project configuration (${sourcePath})`);

    // Helper to check for disallowed fields in raw object
    const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

    const checkDisallowed = (section: string, allowedKeys: string[]) => {
        const secObj = rawObj[section];
        if (secObj && typeof secObj === "object") {
            for (const key of Object.keys(secObj)) {
                const fullKey = `${section}.${key}`;
                if (!PROJECT_OVERRIDE_ALLOWLIST.has(fullKey)) {
                    throw new ConfigSecurityError(
                        `Project configuration (${sourcePath}) cannot override security-sensitive setting "${fullKey}". ` +
                            `Project configuration is untrusted. Allowed project settings are: ${Array.from(PROJECT_OVERRIDE_ALLOWLIST).join(", ")}.`,
                    );
                }
            }
        }
    };

    checkDisallowed("model", ["name", "tool_mode"]);
    checkDisallowed("context", [
        "window_tokens",
        "max_output_tokens",
        "safety_margin_tokens",
        "chars_per_token",
    ]);
    checkDisallowed("embedding", ["model", "dimensions"]);
    checkDisallowed("agent", [
        "max_tool_iterations",
        "repeated_tool_call_limit",
        "consecutive_tool_error_limit",
    ]);

    return config;
};
