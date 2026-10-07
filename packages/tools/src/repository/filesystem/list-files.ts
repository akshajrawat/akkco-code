import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../../core/types.js";
import { resolveRepositoryPath } from "./repository-path.js";

const listFilesInputSchema = z.object({
    path: z
        .string()
        .optional()
        .describe(
            "Repository-relative directory path to list (expects a directory, not a file). Defaults to repository root.",
        ),
});

export const createListFilesTool = (
    repositoryRoot: string,
): ToolDefinition<typeof listFilesInputSchema> => ({
    name: "list_files",
    description:
        "List immediate files and directories in a repository directory (expects a directory, not a file).",
    inputSchema: listFilesInputSchema,
    execute: async (input) => {
        const targetPath = input.path ?? ".";
        const canonicalRoot = await fs.realpath(path.resolve(repositoryRoot));
        const resolvedDir = await resolveRepositoryPath(repositoryRoot, targetPath);

        const stats = await fs.stat(resolvedDir);
        if (!stats.isDirectory()) {
            throw new Error(`Path is not a directory: ${targetPath}`);
        }

        const entries = await fs.readdir(resolvedDir, { withFileTypes: true });

        const results: string[] = [];
        for (const entry of entries) {
            const fullPath = path.join(resolvedDir, entry.name);
            const relPath = path.relative(canonicalRoot, fullPath);

            let isDir = entry.isDirectory();
            if (entry.isSymbolicLink()) {
                try {
                    const stat = await fs.stat(fullPath);
                    isDir = stat.isDirectory();
                } catch {
                    // broken symlink, treat as file
                }
            }

            results.push(isDir ? `${relPath}/` : relPath);
        }

        results.sort((a, b) => a.localeCompare(b));

        return {
            content: results.join("\n"),
        };
    },
});
