import type { ModelTool } from "@akkco/models";

export interface RuntimeToolResult {
    content: string;
}

export interface RuntimeToolHost {
    tools: ModelTool[];
    execute(name: string, input: unknown): Promise<RuntimeToolResult>;
}
