import type { z } from "zod";

export type ToolResult = {
    content: string;
};

export type ToolDefinition<TSchema extends z.ZodType> = {
    name: string;
    description: string;
    inputSchema: TSchema;
    execute: (input: z.infer<TSchema>) => Promise<ToolResult>;
};

export type AnyToolDefinition = ToolDefinition<any>;
