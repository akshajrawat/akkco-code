import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig } from "../../src/config/merge.js";

test("Merge: applies built-in defaults when no other layers are provided", () => {
    const { effectiveConfig, sources } = mergeConfig({});

    assert.strictEqual(effectiveConfig.model.name, "qwen2.5-coder:7b");
    assert.strictEqual(effectiveConfig.model.provider, "openai-compatible");
    assert.strictEqual(effectiveConfig.model.base_url, "http://localhost:11434/v1");
    assert.strictEqual(effectiveConfig.model.tool_mode, "compatibility");
    assert.strictEqual(sources["model.name"], "default");
    assert.strictEqual(sources["model.base_url"], "default");
});

test("Merge: global config overrides built-in defaults", () => {
    const { effectiveConfig, sources } = mergeConfig({
        globalConfig: {
            model: {
                name: "global-model:7b",
                base_url: "http://global-host:11434/v1",
                tool_mode: "native",
            },
            context: {
                window_tokens: 16384,
            },
        },
    });

    assert.strictEqual(effectiveConfig.model.name, "global-model:7b");
    assert.strictEqual(effectiveConfig.model.base_url, "http://global-host:11434/v1");
    assert.strictEqual(effectiveConfig.model.tool_mode, "native");
    assert.strictEqual(effectiveConfig.context.window_tokens, 16384);
    assert.strictEqual(sources["model.name"], "global");
    assert.strictEqual(sources["context.window_tokens"], "global");
});

test("Merge: project config overrides global config for allowed settings", () => {
    const { effectiveConfig, sources } = mergeConfig({
        globalConfig: {
            model: {
                name: "global-model",
                tool_mode: "compatibility",
            },
            context: {
                window_tokens: 8192,
            },
        },
        projectConfig: {
            model: {
                name: "project-specific-model",
                tool_mode: "native",
            },
            context: {
                window_tokens: 32768,
            },
        },
    });

    assert.strictEqual(effectiveConfig.model.name, "project-specific-model");
    assert.strictEqual(effectiveConfig.model.tool_mode, "native");
    assert.strictEqual(effectiveConfig.context.window_tokens, 32768);
    assert.strictEqual(sources["model.name"], "project");
    assert.strictEqual(sources["model.tool_mode"], "project");
    assert.strictEqual(sources["context.window_tokens"], "project");
});

test("Merge: environment variables act as fallback when config files do not specify settings", () => {
    const { effectiveConfig, sources } = mergeConfig({
        envConfig: {
            model: { name: "env-model", tool_mode: "native" },
            context: { window_tokens: 65536 },
            agent: { max_tool_iterations: 15 },
        },
    });

    assert.strictEqual(effectiveConfig.model.name, "env-model");
    assert.strictEqual(effectiveConfig.model.tool_mode, "native");
    assert.strictEqual(effectiveConfig.context.window_tokens, 65536);
    assert.strictEqual(effectiveConfig.agent.max_tool_iterations, 15);
    assert.strictEqual(sources["model.name"], "env");
    assert.strictEqual(sources["model.tool_mode"], "env");
    assert.strictEqual(sources["context.window_tokens"], "env");
    assert.strictEqual(sources["agent.max_tool_iterations"], "env");
});

test("Merge: configuration files take precedence over legacy environment variables", () => {
    const { effectiveConfig, sources } = mergeConfig({
        globalConfig: {
            model: { name: "global-model" },
            context: { window_tokens: 16384 },
        },
        envConfig: {
            model: { name: "env-model", tool_mode: "native" },
            context: { window_tokens: 65536 },
        },
    });

    // globalConfig takes precedence over envConfig for name and window_tokens
    assert.strictEqual(effectiveConfig.model.name, "global-model");
    assert.strictEqual(effectiveConfig.context.window_tokens, 16384);
    assert.strictEqual(sources["model.name"], "global");
    assert.strictEqual(sources["context.window_tokens"], "global");

    // envConfig still provides tool_mode because globalConfig didn't specify it
    assert.strictEqual(effectiveConfig.model.tool_mode, "native");
    assert.strictEqual(sources["model.tool_mode"], "env");
});

test("Merge: project config overrides global config and envConfig for allowed settings", () => {
    const { effectiveConfig, sources } = mergeConfig({
        globalConfig: {
            model: { name: "global-model" },
            context: { window_tokens: 16384 },
        },
        projectConfig: {
            model: { name: "project-model" },
            context: { window_tokens: 32768 },
        },
        envConfig: {
            model: { name: "env-model" },
            context: { window_tokens: 65536 },
        },
    });

    assert.strictEqual(effectiveConfig.model.name, "project-model");
    assert.strictEqual(effectiveConfig.context.window_tokens, 32768);
    assert.strictEqual(sources["model.name"], "project");
    assert.strictEqual(sources["context.window_tokens"], "project");
});

test("Merge: agent reliability limits merge correctly across layers", () => {
    const { effectiveConfig, sources } = mergeConfig({
        globalConfig: {
            agent: {
                max_tool_iterations: 30,
                repeated_tool_call_limit: 5,
            },
        },
        projectConfig: {
            agent: {
                max_tool_iterations: 20,
            },
        },
        envConfig: {
            agent: {
                max_tool_iterations: 10,
                consecutive_tool_error_limit: 6,
            },
        },
    });

    assert.strictEqual(effectiveConfig.agent.max_tool_iterations, 20);
    assert.strictEqual(effectiveConfig.agent.repeated_tool_call_limit, 5);
    assert.strictEqual(effectiveConfig.agent.consecutive_tool_error_limit, 6);
    assert.strictEqual(sources["agent.max_tool_iterations"], "project");
    assert.strictEqual(sources["agent.repeated_tool_call_limit"], "global");
    assert.strictEqual(sources["agent.consecutive_tool_error_limit"], "env");
});

test("Merge: explicit CLI overrides take highest precedence", () => {
    const { effectiveConfig, sources } = mergeConfig({
        globalConfig: { model: { name: "global-model" } },
        projectConfig: { model: { name: "project-model" } },
        envConfig: { model: { name: "env-model" } },
        cliOverrides: {
            model: {
                name: "cli-override-model",
                provider: "cli",
                base_url: "http://cli",
                tool_mode: "native",
            },
        },
    });

    assert.strictEqual(effectiveConfig.model.name, "cli-override-model");
    assert.strictEqual(sources["model.name"], "cli");
});
