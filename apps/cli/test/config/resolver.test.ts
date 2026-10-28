import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GeminiEmbeddingProvider, OpenAICompatibleEmbeddingProvider } from "@akkco/providers";
import { resolveConfig, resolveEmbeddingProvider } from "../../src/config/index.js";

test("Resolver: missing files resolve defaults cleanly", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-resolver-test-"));
    try {
        const resolved = await resolveConfig({
            cwd: tempDir,
            globalConfigPath: path.join(tempDir, "nonexistent-global.toml"),
            projectConfigPath: path.join(tempDir, "nonexistent-project.toml"),
            credentialsPath: path.join(tempDir, "nonexistent-creds.env"),
            env: {},
        });

        assert.strictEqual(resolved.config.model.name, "qwen2.5-coder:7b");
        assert.strictEqual(resolved.loadedFiles.globalExists, false);
        assert.strictEqual(resolved.loadedFiles.projectExists, false);
        assert.strictEqual(resolved.loadedFiles.credentialsExists, false);

        // Check that default profile has 32768 tokens for Qwen2.5-Coder
        assert.strictEqual(resolved.profile.contextWindowTokens, 32768);
        assert.strictEqual(resolved.profile.toolMode, "compatibility");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("Resolver: project config overrides global config and flows into model profile", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-resolver-test-"));
    try {
        const globalToml = `
[model]
name = "qwen2.5-coder:7b"
tool_mode = "compatibility"

[context]
window_tokens = 16384
max_output_tokens = 1024
safety_margin_tokens = 256
`;
        const projectToml = `
[model]
name = "qwen2.5-coder:7b"
tool_mode = "native"

[context]
window_tokens = 8192
max_output_tokens = 512
safety_margin_tokens = 128
`;

        const globalPath = path.join(tempDir, "global.toml");
        const projectPath = path.join(tempDir, "project.toml");
        await fs.writeFile(globalPath, globalToml, "utf8");
        await fs.writeFile(projectPath, projectToml, "utf8");

        const resolved = await resolveConfig({
            cwd: tempDir,
            globalConfigPath: globalPath,
            projectConfigPath: projectPath,
            credentialsPath: path.join(tempDir, "creds.env"),
            env: {},
        });

        // Project settings override global settings
        assert.strictEqual(resolved.config.model.tool_mode, "native");
        assert.strictEqual(resolved.config.context.window_tokens, 8192);
        assert.strictEqual(resolved.config.context.max_output_tokens, 512);

        // Settings flow into the model profile
        assert.strictEqual(resolved.profile.contextWindowTokens, 8192);
        assert.strictEqual(resolved.profile.maxOutputTokens, 512);
        assert.strictEqual(resolved.profile.safetyMarginTokens, 128);
        assert.strictEqual(resolved.profile.toolMode, "native");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("Resolver: loads Gemini credentials from credentials.env without manual export", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-resolver-test-"));
    try {
        const globalToml = `
[embedding]
provider = "gemini"
model = "gemini-embedding-001"
dimensions = 768
api_key_env = "GEMINI_API_KEY"
`;
        const credsEnv = `
# Private credentials
GEMINI_API_KEY=test-gemini-key-from-credentials-file
`;
        const globalPath = path.join(tempDir, "config.toml");
        const credsPath = path.join(tempDir, "credentials.env");
        await fs.writeFile(globalPath, globalToml, "utf8");
        await fs.writeFile(credsPath, credsEnv, "utf8");

        const resolved = await resolveConfig({
            cwd: tempDir,
            globalConfigPath: globalPath,
            projectConfigPath: path.join(tempDir, "nonexistent.toml"),
            credentialsPath: credsPath,
            env: {}, // Empty environment, simulating no manual export
        });

        assert.strictEqual(resolved.loadedFiles.credentialsExists, true);
        assert.strictEqual(resolved.env.GEMINI_API_KEY, "test-gemini-key-from-credentials-file");

        // Resolve embedding provider using the resolved configuration
        const provider = await resolveEmbeddingProvider({
            env: resolved.env,
            config: resolved.config.embedding,
            modelConfig: resolved.config.model,
        });

        assert.ok(provider instanceof GeminiEmbeddingProvider);
        assert.strictEqual(provider.id, "gemini");
        assert.strictEqual(provider.model, "gemini-embedding-001");
        assert.strictEqual(provider.dimensions, 768);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("Resolver: shell environment variable takes precedence over credentials.env", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-resolver-test-"));
    try {
        const credsEnv = `GEMINI_API_KEY=file-key`;
        const credsPath = path.join(tempDir, "credentials.env");
        await fs.writeFile(credsPath, credsEnv, "utf8");

        const resolved = await resolveConfig({
            cwd: tempDir,
            globalConfigPath: path.join(tempDir, "nonexistent.toml"),
            projectConfigPath: path.join(tempDir, "nonexistent.toml"),
            credentialsPath: credsPath,
            env: {
                GEMINI_API_KEY: "shell-precedence-key",
            },
        });

        // Shell variable must take precedence!
        assert.strictEqual(resolved.env.GEMINI_API_KEY, "shell-precedence-key");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("Resolver: config files take precedence over environment variables", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-resolver-test-"));
    try {
        const globalToml = `
[model]
name = "config-specified-model"
tool_mode = "native"

[context]
window_tokens = 65536

[agent]
max_tool_iterations = 40
`;
        const globalPath = path.join(tempDir, "config.toml");
        await fs.writeFile(globalPath, globalToml, "utf8");

        const resolved = await resolveConfig({
            cwd: tempDir,
            globalConfigPath: globalPath,
            projectConfigPath: path.join(tempDir, "nonexistent.toml"),
            credentialsPath: path.join(tempDir, "nonexistent.env"),
            env: {
                AKKCO_MODEL: "env-overridden-model",
                AKKCO_TOOL_MODE: "compatibility",
                AKKCO_CONTEXT_WINDOW_TOKENS: "8192",
                AKKCO_MAX_TOOL_ITERATIONS: "10",
                // Setting NOT specified in config.toml should still fall back to env:
                AKKCO_MAX_OUTPUT_TOKENS: "4096",
            },
        });

        // Config file wins for settings it defines:
        assert.strictEqual(resolved.config.model.name, "config-specified-model");
        assert.strictEqual(resolved.config.model.tool_mode, "native");
        assert.strictEqual(resolved.config.context.window_tokens, 65536);
        assert.strictEqual(resolved.config.agent.max_tool_iterations, 40);
        assert.strictEqual(resolved.sources["model.name"], "global");
        assert.strictEqual(resolved.sources["model.tool_mode"], "global");
        assert.strictEqual(resolved.sources["context.window_tokens"], "global");
        assert.strictEqual(resolved.sources["agent.max_tool_iterations"], "global");

        // Environment variable acts as fallback for settings omitted from config file:
        assert.strictEqual(resolved.config.context.max_output_tokens, 4096);
        assert.strictEqual(resolved.sources["context.max_output_tokens"], "env");

        // Profile reflects config file precedence:
        assert.strictEqual(resolved.profile.contextWindowTokens, 65536);
        assert.strictEqual(resolved.profile.maxOutputTokens, 4096);
        assert.strictEqual(resolved.profile.toolMode, "native");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
