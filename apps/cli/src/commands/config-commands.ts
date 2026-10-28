import { stringify } from "smol-toml";
import { redactObjectSecrets, resolveConfig } from "../config/index.js";
import type { CliCommand, CommandContext } from "./command-registry.js";

export * from "./config-cli.js";

/**
 * Interactive slash commands for inspecting configuration within a session.
 */
export const configCommands: CliCommand[] = [
    {
        name: "config",
        description: "Display effective configuration with secrets redacted",
        usage: "/config [show]",
        execute: async (args: string, context: CommandContext) => {
            const sub = args.trim().toLowerCase();
            if (sub && sub !== "show") {
                context.notice(
                    `Unknown config argument: "${args}". Usage: /config [show]`,
                    "error",
                );
                return;
            }

            try {
                const resolved = await resolveConfig({
                    cwd: context.metadata?.cwd ?? process.cwd(),
                });
                const redacted = redactObjectSecrets(resolved.config);
                let tomlStr = "";
                try {
                    tomlStr = stringify(redacted as unknown as Record<string, unknown>).trim();
                } catch {
                    tomlStr = JSON.stringify(redacted, null, 2);
                }

                context.notice(
                    `Effective configuration:\n${tomlStr}\n\nGlobal: ${resolved.paths.globalConfig} [${resolved.loadedFiles.globalExists ? "FOUND" : "NOT FOUND"}]\nProject: ${resolved.paths.projectConfig ?? "None"} [${resolved.loadedFiles.projectExists ? "FOUND" : "NOT FOUND"}]`,
                    "info",
                );
            } catch (error) {
                context.notice(
                    `Failed to resolve configuration: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            }
        },
    },
];
