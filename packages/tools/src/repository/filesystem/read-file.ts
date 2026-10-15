import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../../core/types.js";
import { resolveRepositoryPath } from "./repository-path.js";

const readFileInputSchema = z.object({
    path: z
        .string()
        .min(1, "Path cannot be empty")
        .describe(
            "Repository-relative path to the file to read (expects a file, not a directory).",
        ),
});

export const DEFAULT_MAX_READ_BYTES = 5 * 1024 * 1024; // 5 MB

export const createReadFileTool = (
    repositoryRoot: string,
    maxBytes: number = DEFAULT_MAX_READ_BYTES,
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
        if (!stats.isFile()) {
            throw new Error(`Cannot read path because it is not a regular file: ${input.path}`);
        }
        if (stats.size > maxBytes) {
            throw new Error(
                `File size (${stats.size} bytes) exceeds maximum readable size of ${maxBytes} bytes: ${input.path}`,
            );
        }
        const content = await fs.readFile(filePath, "utf-8");
        return { content };
    },
});
