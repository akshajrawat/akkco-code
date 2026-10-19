import type { ModelTool } from "@akkco/models";
import { zodToJsonSchema } from "zod-to-json-schema";
import { toJSONSchema } from "zod/v4";
import type { AnyToolDefinition } from "../core/types.js";

const normalizeInputSchema = (schema: unknown): Record<string, unknown> => {
    let rawSchema: Record<string, unknown>;
    if (schema && typeof schema === "object" && "_zod" in schema) {
        rawSchema = toJSONSchema(schema as any) as Record<string, unknown>;
    } else {
        rawSchema = zodToJsonSchema(schema as any) as Record<string, unknown>;
    }

    const { $schema, ...normalized } = rawSchema;
    return normalized;
};

/**
 * Converts an internal ToolDefinition into a provider-neutral ModelTool,
 * serializing its schema to standard JSON Schema for model consumption.
 */
export const toModelTool = (tool: AnyToolDefinition): ModelTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: normalizeInputSchema(tool.inputSchema),
});

export const toModelTools = (tools: AnyToolDefinition[]): ModelTool[] => tools.map(toModelTool);
