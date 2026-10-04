import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../../core/types.js";
import { resolveRepositoryPath } from "./repository-path.js";

const readFileInputSchema = z.object({
    path: z
        .string()
        .min(1, "Path cannot be empty")
        .describe("Path to the file to read (expects a file, not a directory)."),
});

export const createReadFileTool = (
    repositoryRoot: string,
): ToolDefinition<typeof readFileInputSchema> => ({
    name: "read_file",
    description:
        "Read the full contents of a file from the repository as UTF-8 text (expects a file, not a directory).",
    inputSchema: readFileInputSchema,
    execute: async (input) => {
        const filePath = await resolveRepositoryPath(repositoryRoot, input.path);
        const stats = await fs.stat(filePath);
        if (stats.isDirectory()) {
            throw new Error(`Cannot read path because it is a directory: ${input.path}`);
        }
        const content = await fs.readFile(filePath, "utf-8");
        return { content };
    },
});
