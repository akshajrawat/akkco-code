import type { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const executeTool = async <TSchema extends z.ZodType>(
    tool: ToolDefinition<TSchema>,
    rawInput: unknown,
) => {
    const validatedInput = tool.inputSchema.parse(rawInput);
    return tool.execute(validatedInput);
};
