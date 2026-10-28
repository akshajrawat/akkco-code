import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    configCommands,
    handleConfigCommand,
    runConfigInit,
    runConfigShow,
    runConfigValidate,
} from "../src/commands/config-commands.js";

test("Commands: runConfigShow displays effective config with secrets redacted", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-cmd-test-"));
    const logs: string[] = [];
    const log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
        const globalToml = `
[model]
name = "qwen2.5-coder:7b"
api_key = "super-secret-model-key"

[embedding]
provider = "gemini"
api_key = "super-secret-gemini-key"
`;
        const globalPath = path.join(tempDir, "config.toml");
        await fs.writeFile(globalPath, globalToml, "utf8");

        const exitCode = await runConfigShow({
            log,
            options: {
                cwd: tempDir,
                globalConfigPath: globalPath,
                projectConfigPath: path.join(tempDir, "nonexistent.toml"),
                credentialsPath: path.join(tempDir, "nonexistent.env"),
                env: {},
            },
        });

        assert.strictEqual(exitCode, 0);
        const fullOutput = logs.join("\n");

        // Verify secrets are NOT present in output
        assert.strictEqual(fullOutput.includes("super-secret-model-key"), false);
        assert.strictEqual(fullOutput.includes("super-secret-gemini-key"), false);

        // Verify [REDACTED] is present
        assert.ok(fullOutput.includes("[REDACTED]"));
        assert.ok(fullOutput.includes("=== AKKCO Code Configuration ==="));
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("Commands: runConfigValidate detects valid and invalid files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-cmd-test-"));
    const logs: string[] = [];
    const errors: string[] = [];
    const log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const error = (...args: unknown[]) => errors.push(args.map(String).join(" "));

    try {
        // 1. Valid file
        const validPath = path.join(tempDir, "config.toml");
        await fs.writeFile(validPath, "[context]\nwindow_tokens = 32768\n", "utf8");

        let exitCode = await runConfigValidate({
            log,
            error,
            options: {
                cwd: tempDir,
                globalConfigPath: validPath,
                projectConfigPath: path.join(tempDir, "nonexistent.toml"),
                credentialsPath: path.join(tempDir, "nonexistent.env"),
                env: {},
            },
        });
        assert.strictEqual(exitCode, 0);
        assert.ok(logs.join("\n").includes("Global configuration is valid"));

        // 2. Invalid file (schema violation)
        logs.length = 0;
        errors.length = 0;
        await fs.writeFile(validPath, "[context]\nwindow_tokens = -100\n", "utf8");

        exitCode = await runConfigValidate({
            log,
            error,
            options: {
                cwd: tempDir,
                globalConfigPath: validPath,
                projectConfigPath: path.join(tempDir, "nonexistent.toml"),
                credentialsPath: path.join(tempDir, "nonexistent.env"),
                env: {},
            },
        });
        assert.strictEqual(exitCode, 1);
        assert.ok(errors.join("\n").includes("window_tokens must be a positive integer"));
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("Commands: runConfigInit creates files and does not overwrite existing ones", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-cmd-test-"));
    const logs: string[] = [];
    const log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
        const globalConfig = path.join(tempDir, "config.toml");
        const credentialsFile = path.join(tempDir, "credentials.env");

        // First run: should create both files
        let exitCode = await runConfigInit([], {
            log,
            options: {
                cwd: tempDir,
                env: {
                    AKKCO_GLOBAL_CONFIG_DIR: tempDir,
                    AKKCO_GLOBAL_CONFIG: globalConfig,
                    AKKCO_CREDENTIALS_FILE: credentialsFile,
                },
            },
        });
        assert.strictEqual(exitCode, 0);

        const configContent = await fs.readFile(globalConfig, "utf8");
        const credsContent = await fs.readFile(credentialsFile, "utf8");
        assert.ok(configContent.includes("[model]"));
        assert.ok(credsContent.includes("GEMINI_API_KEY"));

        // Second run: should NOT overwrite
        logs.length = 0;
        exitCode = await runConfigInit([], {
            log,
            options: {
                cwd: tempDir,
                env: {
                    AKKCO_GLOBAL_CONFIG_DIR: tempDir,
                    AKKCO_GLOBAL_CONFIG: globalConfig,
                    AKKCO_CREDENTIALS_FILE: credentialsFile,
                },
            },
        });
        assert.strictEqual(exitCode, 0);
        assert.ok(logs.join("\n").includes("already exists"));

        // Modify config, ensure it was not overwritten
        await fs.writeFile(globalConfig, "# custom modification", "utf8");
        await runConfigInit([], {
            log,
            options: {
                cwd: tempDir,
                env: {
                    AKKCO_GLOBAL_CONFIG_DIR: tempDir,
                    AKKCO_GLOBAL_CONFIG: globalConfig,
                    AKKCO_CREDENTIALS_FILE: credentialsFile,
                },
            },
        });
        const preserved = await fs.readFile(globalConfig, "utf8");
        assert.strictEqual(preserved, "# custom modification");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("Commands: runConfigInit --project creates starter project config with embedding guide and clean header", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-cmd-test-"));
    const logs: string[] = [];
    const log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
        const repoDir = path.join(tempDir, "test-repo");
        await fs.mkdir(repoDir, { recursive: true });
        await fs.writeFile(path.join(repoDir, ".git"), "gitdir: ...", "utf8");

        const exitCode = await runConfigInit(["--project"], {
            log,
            options: {
                cwd: repoDir,
            },
        });
        assert.strictEqual(exitCode, 0);

        const projectConfigPath = path.join(repoDir, ".akkco", "config.toml");
        const content = await fs.readFile(projectConfigPath, "utf8");

        // Header check
        assert.ok(content.startsWith("# AKKCO Code Project Configuration"));
        assert.strictEqual(content.includes("Settings here override global configuration"), false);
        assert.strictEqual(content.includes("Security-sensitive settings"), false);
        assert.strictEqual(content.includes("Target model for this repository"), false);

        // Embedding guide check
        assert.ok(content.includes("# Embedding Configuration"));
        assert.ok(
            content.includes(
                "# To enable Gemini or another embedding provider, configure\n# `provider` in the global config, not this project config.\n# API keys belong in global credentials.env.",
            ),
        );
        assert.ok(
            content.includes('# [embedding]\n# model = "gemini-embedding-001"\n# dimensions = 768'),
        );

        // Validate that generated file parses cleanly
        const { loadConfigFile } = await import("../src/config/loader.js");
        const loaded = await loadConfigFile(projectConfigPath, { isProject: true });
        assert.strictEqual(loaded.exists, true);
        assert.strictEqual(loaded.config.model?.name, "qwen2.5-coder:7b");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("Commands: handleConfigCommand dispatches subcommands and shows help", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const error = (...args: unknown[]) => errors.push(args.map(String).join(" "));

    const helpCode = await handleConfigCommand(["--help"], { log, error });
    assert.strictEqual(helpCode, 0);
    assert.ok(logs.join("\n").includes("Usage: akkco config <subcommand>"));

    const unknownCode = await handleConfigCommand(["unknown_cmd"], { log, error });
    assert.strictEqual(unknownCode, 1);
    assert.ok(errors.join("\n").includes('Unknown config subcommand: "unknown_cmd"'));
});

test("Commands: interactive /config command executes via CommandRegistry", async () => {
    const configCmd = configCommands.find((c) => c.name === "config");
    assert.ok(configCmd);

    const notices: { content: string; kind?: string }[] = [];
    const mockContext = {
        session: {} as any,
        toolRegistry: {} as any,
        appendHistory: () => {},
        notice: (content: string, kind?: "info" | "error" | "warning") => {
            notices.push({ content, kind });
        },
        exit: () => {},
        clearHistory: () => {},
        startTool: () => {},
        finishTool: () => {},
    };

    await configCmd.execute("", mockContext);
    assert.strictEqual(notices.length, 1);
    assert.ok(notices[0]?.content.includes("Effective configuration:"));
    assert.ok(notices[0]?.content.includes("qwen2.5-coder:7b"));

    // Test invalid argument
    notices.length = 0;
    await configCmd.execute("invalid_arg", mockContext);
    assert.strictEqual(notices.length, 1);
    assert.strictEqual(notices[0]?.kind, "error");
    assert.ok(notices[0]?.content.includes("Unknown config argument"));
});
