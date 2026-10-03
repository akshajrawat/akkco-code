import type { CliCommand } from "./command-registry.js";

export const exitCommand: CliCommand = {
    name: "exit",
    description: "Exit the Akkco Code CLI",
    usage: "/exit",
    execute: (_args, context) => {
        context.exit();
    },
};

export const clearCommand: CliCommand = {
    name: "clear",
    description: "Clear the conversation session and display history",
    usage: "/clear",
    execute: (_args, context) => {
        context.session.clear();
        context.clearHistory();
        context.notice("Conversation cleared.");
    },
};

export const sessionCommands = [exitCommand, clearCommand];
