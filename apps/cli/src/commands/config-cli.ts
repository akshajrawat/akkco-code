import fs from "node:fs";
import fsp from "node:fs/promises";
import { stringify } from "smol-toml";
import {
    createCredentialsTemplate,
    parseCredentialsEnv,
    redactObjectSecrets,
} from "../config/credentials.js";
import { loadConfigFile } from "../config/loader.js";
import { resolveConfigPaths } from "../config/paths.js";
import { resolveConfig, type ResolveConfigOptions } from "../config/resolver.js";

export interface ConfigCommandContext {
    readonly log?: (...args: unknown[]) => void;
    readonly error?: (...args: unknown[]) => void;
    readonly options?: ResolveConfigOptions;
}

const GLOBAL_CONFIG_TEMPLATE = `# AKKCO Code Global Configuration
# Documentation: https://github.com/akkco/akkco-code/blob/main/docs/configuration.md

[model]
name = "qwen2.5-coder:7b"
provider = "openai-compatible"
base_url = "http://localhost:11434/v1"
tool_mode = "compatibility"

[context]
# Context limits must match your local inference server (e.g. Ollama num_ctx)
window_tokens = 32768
max_output_tokens = 2048
safety_margin_tokens = 512

# Embedding Configuration
# Cloud-hosted embeddings via Google Gemini or local via OpenAI-compatible.
# Private credentials belong in credentials.env (e.g. GEMINI_API_KEY=your_key_here).
# [embedding]
# provider = "gemini"
# model = "gemini-embedding-001"
# dimensions = 768
# api_key_env = "GEMINI_API_KEY"

[agent]
max_tool_iterations = 25
`;

const PROJECT_CONFIG_TEMPLATE = `# AKKCO Code Project Configuration

[model]
name = "qwen2.5-coder:7b"
tool_mode = "compatibility"

[context]
window_tokens = 32768
max_output_tokens = 2048
safety_margin_tokens = 512

# Embedding Configuration
# To enable Gemini or another embedding provider, configure
# \`provider\` in the global config, not this project config.
# API keys belong in global credentials.env.

# [embedding]
# model = "gemini-embedding-001"
# dimensions = 768

[agent]
max_tool_iterations = 25
`;

/**
 * Executes the shell-level `akkco config show` command.
 * Displays effective configuration with all secrets strictly redacted.
 */
export const runConfigShow = async (context?: ConfigCommandContext): Promise<number> => {
    const log = context?.log ?? console.log;
    const resolved = await resolveConfig(context?.options);

    log("=== AKKCO Code Configuration ===");
    log("");
    log("Configuration sources:");
    log(
        `  Global config:   ${resolved.paths.globalConfig} [${resolved.loadedFiles.globalExists ? "FOUND" : "NOT FOUND"}]`,
    );
    log(
        `  Credentials:     ${resolved.paths.credentialsFile} [${resolved.loadedFiles.credentialsExists ? "FOUND" : "NOT FOUND"}]`,
    );
    log(
        `  Project config:  ${resolved.paths.projectConfig ?? "None"} [${resolved.loadedFiles.projectExists ? "FOUND" : "NOT FOUND"}]`,
    );
    log("");

    const redacted = redactObjectSecrets(resolved.config);
    log("Effective configuration:");
    try {
        log(stringify(redacted as unknown as Record<string, unknown>).trim());
    } catch {
        log(JSON.stringify(redacted, null, 2));
    }

    log("");
    log("Configuration origins:");
    for (const [key, source] of Object.entries(resolved.sources)) {
        log(`  ${key}: [${source.toUpperCase()}]`);
    }

    return 0;
};

/**
 * Executes the shell-level `akkco config validate` command.
 * Validates syntax, types, invariants, and security rules across all configuration files.
 */
export const runConfigValidate = async (context?: ConfigCommandContext): Promise<number> => {
    const log = context?.log ?? console.log;
    const errorLog = context?.error ?? console.error;
    const paths = resolveConfigPaths(context?.options);

    let hasErrors = false;
    let checkedCount = 0;

    // Validate global config
    if (fs.existsSync(paths.globalConfig)) {
        checkedCount++;
        try {
            await loadConfigFile(paths.globalConfig, { isProject: false });
            log(`✔ Global configuration is valid: ${paths.globalConfig}`);
        } catch (err) {
            hasErrors = true;
            errorLog(
                `✖ Global configuration error (${paths.globalConfig}): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // Validate project config
    if (paths.projectConfig && fs.existsSync(paths.projectConfig)) {
        checkedCount++;
        try {
            await loadConfigFile(paths.projectConfig, { isProject: true });
            log(`✔ Project configuration is valid: ${paths.projectConfig}`);
        } catch (err) {
            hasErrors = true;
            errorLog(
                `✖ Project configuration error (${paths.projectConfig}): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // Validate credentials file
    if (fs.existsSync(paths.credentialsFile)) {
        checkedCount++;
        try {
            const content = await fsp.readFile(paths.credentialsFile, "utf8");
            parseCredentialsEnv(content);
            log(`✔ Credentials file is valid: ${paths.credentialsFile}`);

            // POSIX permission check
            if (process.platform !== "win32") {
                const stat = await fsp.stat(paths.credentialsFile);
                const mode = stat.mode & 0o777;
                if ((mode & 0o077) !== 0) {
                    log(
                        `  ⚠ Notice: Credentials file permissions are 0o${mode.toString(8)}. Recommended: chmod 600 "${paths.credentialsFile}"`,
                    );
                }
            }
        } catch (err) {
            hasErrors = true;
            errorLog(
                `✖ Credentials file error (${paths.credentialsFile}): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    if (checkedCount === 0) {
        log("No configuration files found. Built-in defaults are active.");
        return 0;
    }

    if (hasErrors) {
        return 1;
    }

    log("All configuration files validated successfully.");
    return 0;
};

/**
 * Executes the shell-level `akkco config init` command.
 * Creates starter global config and credentials template without overwriting existing files.
 */
export const runConfigInit = async (
    args: string[] = [],
    context?: ConfigCommandContext,
): Promise<number> => {
    const log = context?.log ?? console.log;
    const paths = resolveConfigPaths(context?.options);
    const isProject = args.includes("--project") || args.includes("-p");

    if (isProject) {
        if (!paths.projectConfig || !paths.projectDir) {
            log("Error: Could not determine repository root for project configuration.");
            return 1;
        }

        if (fs.existsSync(paths.projectConfig)) {
            log(`Project configuration already exists: ${paths.projectConfig} (skipped)`);
            return 0;
        }

        await fsp.mkdir(paths.projectDir, { recursive: true });
        await fsp.writeFile(paths.projectConfig, PROJECT_CONFIG_TEMPLATE, "utf8");
        log(`Created starter project configuration: ${paths.projectConfig}`);
        return 0;
    }

    // Global initialization
    await fsp.mkdir(paths.globalDir, { recursive: true, mode: 0o700 });

    if (fs.existsSync(paths.globalConfig)) {
        log(`Global configuration already exists: ${paths.globalConfig} (skipped)`);
    } else {
        await fsp.writeFile(paths.globalConfig, GLOBAL_CONFIG_TEMPLATE, {
            mode: 0o644,
            flag: "wx",
        });
        log(`Created starter global configuration: ${paths.globalConfig}`);
    }

    const credsResult = await createCredentialsTemplate(paths.credentialsFile);
    if (credsResult.created) {
        log(`Created private credentials template: ${paths.credentialsFile} (mode 0600)`);
    } else {
        log(`Credentials file already exists: ${paths.credentialsFile} (skipped)`);
    }

    return 0;
};

/**
 * Dispatches shell-level `akkco config <subcommand>` arguments.
 */
export const handleConfigCommand = async (
    args: string[],
    context?: ConfigCommandContext,
): Promise<number> => {
    const log = context?.log ?? console.log;
    const subcommand = args[0]?.toLowerCase().trim();

    switch (subcommand) {
        case "show":
            return await runConfigShow(context);
        case "validate":
            return await runConfigValidate(context);
        case "init":
            return await runConfigInit(args.slice(1), context);
        case "help":
        case "--help":
        case "-h":
        case undefined:
            log("Usage: akkco config <subcommand> [options]");
            log("");
            log("Subcommands:");
            log("  show       Display effective configuration with secrets redacted");
            log("  validate   Validate configuration syntax and identify invalid fields");
            log("  init       Create starter configuration and credentials templates");
            log("");
            log("Options for 'init':");
            log("  --project, -p   Initialize .akkco/config.toml in the current repository");
            return 0;
        default:
            const errorLog = context?.error ?? console.error;
            errorLog(
                `Unknown config subcommand: "${subcommand}". Run "akkco config help" for available commands.`,
            );
            return 1;
    }
};
