import { executeTool } from "./executor.js";
import type { AnyToolDefinition, ToolResult } from "./types.js";

export class ToolRegistry {
    private readonly tools = new Map<string, AnyToolDefinition>();

    constructor(initialTools: AnyToolDefinition[] = []) {
        for (const tool of initialTools) {
            this.register(tool);
        }
    }

    register = (tool: AnyToolDefinition) => {
        if (this.tools.has(tool.name)) {
            throw new Error(`Tool already registered: ${tool.name}`);
        }
        this.tools.set(tool.name, tool);
    };

    get = (name: string): AnyToolDefinition | undefined => {
        return this.tools.get(name);
    };

    list = (): AnyToolDefinition[] => {
        return Array.from(this.tools.values());
    };

    execute = async (name: string, rawInput: unknown): Promise<ToolResult> => {
        const tool = this.tools.get(name);
        if (!tool) {
            throw new Error(`Unknown tool: ${name}`);
        }
        return executeTool(tool, rawInput);
    };
}

export const createToolRegistry = (initialTools: AnyToolDefinition[] = []) =>
    new ToolRegistry(initialTools);
