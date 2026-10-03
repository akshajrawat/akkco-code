import type { CliCommand } from "./command-registry.js";

export const toolsCommand: CliCommand = {
    name: "tools",
    description: "List available repository tools",
    usage: "/tools",
    execute: (_args, context) => {
        context.appendHistory({
            type: "tools",
            tools: context.toolRegistry.list().map(({ name, description }) => ({
                name,
                description,
            })),
        });
    },
};

export const toolCommand: CliCommand = {
    name: "tool",
    description: "Manually execute a registered tool with optional JSON arguments",
    usage: "/tool <name> [json]",
    execute: async (args, context) => {
        if (!args) {
            context.notice("Usage: /tool <name> [json]", "error");
            return;
        }

        const firstSpace = args.indexOf(" ");
        const toolName = firstSpace === -1 ? args : args.slice(0, firstSpace);
        const rawJson = firstSpace === -1 ? "{}" : args.slice(firstSpace + 1).trim();

        let toolInput: unknown;
        try {
            toolInput = JSON.parse(rawJson || "{}");
        } catch {
            context.notice("Error: Invalid JSON input for tool.", "error");
            return;
        }

        context.startTool(toolName, toolInput);
        const started = Date.now();

        try {
            const result = await context.toolRegistry.execute(toolName, toolInput);

            context.finishTool({
                toolName,
                arguments: toolInput,
                status: "completed",
                durationMs: Date.now() - started,
                result: result.content,
                showResult: true,
            });
        } catch (error) {
            context.finishTool({
                toolName,
                arguments: toolInput,
                status: "failed",
                durationMs: Date.now() - started,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    },
};

export const toolCommands = [toolsCommand, toolCommand];
