import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../../core/types.js";
import { isInsideRoot, resolveRepositoryPath } from "./repository-path.js";

const searchTextInputSchema = z.object({
    query: z.string().min(1, "Query cannot be empty"),
    path: z.string().optional(),
});

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

export const createSearchTextTool = (
    repositoryRoot: string,
    maxMatches = 100,
): ToolDefinition<typeof searchTextInputSchema> => ({
    name: "search_text",
    description: "Search recursively for literal text within files in the repository.",
    inputSchema: searchTextInputSchema,
    execute: async (input) => {
        const targetPath = input.path ?? ".";
        const canonicalRoot = await fs.realpath(path.resolve(repositoryRoot));
        const resolvedTarget = await resolveRepositoryPath(repositoryRoot, targetPath);

        const targetStats = await fs.stat(resolvedTarget);

        const filesToSearch: string[] = [];

        const collectFiles = async (dir: string, visited: Set<string>) => {
            const realDir = await fs.realpath(dir).catch(() => null);
            if (!realDir || !isInsideRoot(canonicalRoot, realDir) || visited.has(realDir)) {
                return;
            }
            visited.add(realDir);

            const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
            if (!entries) {
                return;
            }

            for (const entry of entries) {
                if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) {
                    continue;
                }

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await collectFiles(fullPath, visited);
                } else if (entry.isSymbolicLink()) {
                    try {
                        const real = await fs.realpath(fullPath);
                        if (!isInsideRoot(canonicalRoot, real)) {
                            continue;
                        }
                        const stat = await fs.stat(real);
                        if (stat.isDirectory()) {
                            if (!SKIPPED_DIRS.has(entry.name)) {
                                await collectFiles(fullPath, visited);
                            }
                        } else if (stat.isFile()) {
                            filesToSearch.push(fullPath);
                        }
                    } catch {
                        // ignore broken symlink
                    }
                } else if (entry.isFile()) {
                    filesToSearch.push(fullPath);
                }
            }
        };

        if (targetStats.isFile()) {
            filesToSearch.push(resolvedTarget);
        } else if (targetStats.isDirectory()) {
            await collectFiles(resolvedTarget, new Set());
        }

        filesToSearch.sort((a, b) => a.localeCompare(b));

        const matches: string[] = [];
        let truncated = false;

        for (const filePath of filesToSearch) {
            let content: string;
            try {
                content = await fs.readFile(filePath, "utf-8");
            } catch {
                continue;
            }

            // Skip binary files
            if (content.includes("\0")) {
                continue;
            }

            const relPath = path.relative(canonicalRoot, filePath);
            const lines = content.split("\n");

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.includes(input.query)) {
                    const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
                    matches.push(`${relPath}:${i + 1}:${cleanLine}`);
                    if (matches.length >= maxMatches) {
                        truncated = true;
                        break;
                    }
                }
            }

            if (truncated) {
                break;
            }
        }

        if (matches.length === 0) {
            return {
                content: "No matches found.",
            };
        }

        let output = matches.join("\n");
        if (truncated) {
            output += `\n[Results truncated: maximum ${maxMatches} matches reached]`;
        }

        return {
            content: output,
        };
    },
});
