import type { Session } from "@akkco/core";
import type { ToolRegistry } from "@akkco/tools";
import type { HistoryItemPayload, ToolExecutionState } from "../state/types.js";
import { sessionCommands } from "./session-commands.js";
import { toolCommands } from "./tool-commands.js";

export interface CommandContext {
    readonly session: Session;
    readonly toolRegistry: ToolRegistry;
    appendHistory: (item: HistoryItemPayload) => void;
    notice: (content: string, kind?: "info" | "error" | "warning") => void;
    exit: (farewell?: boolean) => void;
    clearHistory: () => void;
    startTool: (toolName: string, input: unknown) => void;
    finishTool: (execution: ToolExecutionState) => void;
}

export type CliCommand = {
    name: string;
    description: string;
    usage?: string;
    execute: (args: string, context: CommandContext) => Promise<void> | void;
};

export type CommandMetadata = {
    readonly name: string;
    readonly description: string;
    readonly usage?: string;
};

export class CommandRegistry {
    private readonly commands = new Map<string, CliCommand>();

    constructor(initialCommands: CliCommand[] = []) {
        for (const command of initialCommands) {
            this.register(command);
        }
    }

    register = (command: CliCommand) => {
        const key = command.name.replace(/^\//, "").toLowerCase().trim();

        if (!key) {
            throw new Error("Command name cannot be empty");
        }

        if (this.commands.has(key)) {
            throw new Error(`Command already registered: /${key}`);
        }

        this.commands.set(key, command);
    };

    get = (name: string): CliCommand | undefined => {
        const key = name.replace(/^\//, "").toLowerCase().trim();
        return this.commands.get(key);
    };

    list = (): readonly CommandMetadata[] => {
        return Array.from(this.commands.values()).map(({ name, description, usage }) => ({
            name,
            description,
            usage,
        }));
    };

    dispatch = async (input: string, context: CommandContext): Promise<boolean> => {
        const trimmed = input.trim();

        if (!trimmed.startsWith("/")) {
            return false;
        }

        const withoutSlash = trimmed.slice(1);
        const firstSpace = withoutSlash.search(/\s/);

        const rawName = firstSpace === -1 ? withoutSlash : withoutSlash.slice(0, firstSpace);
        const commandName = rawName.toLowerCase();
        const args = firstSpace === -1 ? "" : withoutSlash.slice(firstSpace + 1).trim();

        const command = this.commands.get(commandName);

        if (!command) {
            context.notice(`Unknown command: /${rawName}`, "error");
            return true;
        }

        await command.execute(args, context);
        return true;
    };
}

export const createCommandRegistry = (initialCommands: CliCommand[] = []) => {
    return new CommandRegistry(initialCommands);
};

export const createBuiltinCommandRegistry = () => {
    return createCommandRegistry([...sessionCommands, ...toolCommands]);
};

export const createDefaultCommandRegistry = createBuiltinCommandRegistry;
