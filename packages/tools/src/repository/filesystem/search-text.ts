import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../../core/types.js";
import { isInsideRoot, resolveRepositoryPath } from "./repository-path.js";

const searchTextInputSchema = z.object({
    query: z
        .string()
        .min(1, "Query cannot be empty")
        .describe("Literal text string to search for."),
    path: z
        .string()
        .optional()
        .describe(
            "Repository-relative search root or directory path to search recursively within (path is a search root/directory). Defaults to repository root.",
        ),
});

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

export const DEFAULT_MAX_MATCHES = 100;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_MAX_FILES = 5000;

export interface SearchTextOptions {
    readonly maxMatches?: number;
    readonly maxOutputBytes?: number;
    readonly maxFileBytes?: number;
    readonly maxFiles?: number;
}

export const createSearchTextTool = (
    repositoryRoot: string,
    maxMatchesOrOptions: number | SearchTextOptions = DEFAULT_MAX_MATCHES,
): ToolDefinition<typeof searchTextInputSchema> => {
    const opts =
        typeof maxMatchesOrOptions === "number"
            ? { maxMatches: maxMatchesOrOptions }
            : maxMatchesOrOptions;
    const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

    return {
        name: "search_text",
        description:
            "Search recursively for literal text within files in the repository (path is a search root/directory).",
        inputSchema: searchTextInputSchema,
        execute: async (input) => {
            const targetPath = input.path ?? ".";
            const canonicalRoot = await fs.realpath(path.resolve(repositoryRoot));
            const resolvedTarget = await resolveRepositoryPath(repositoryRoot, targetPath);

            const targetStats = await fs.stat(resolvedTarget);

            const filesToSearch: string[] = [];

            const collectFiles = async (dir: string, visited: Set<string>) => {
                if (filesToSearch.length >= maxFiles) {
                    return;
                }

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
                    if (filesToSearch.length >= maxFiles) {
                        break;
                    }

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
            let currentBytes = 0;
            let truncated = false;
            let byteTruncated = false;

            for (const filePath of filesToSearch) {
                let stat: import("node:fs").Stats;
                try {
                    stat = await fs.stat(filePath);
                } catch {
                    continue;
                }

                if (!stat.isFile() || stat.size > maxFileBytes) {
                    continue;
                }

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
                        const matchEntry = `${relPath}:${i + 1}:${cleanLine}`;

                        if (currentBytes + matchEntry.length + 1 > maxOutputBytes) {
                            truncated = true;
                            byteTruncated = true;
                            break;
                        }

                        matches.push(matchEntry);
                        currentBytes += matchEntry.length + 1;

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
                if (byteTruncated) {
                    output += `\n[Results truncated: maximum ${maxOutputBytes} bytes reached]`;
                } else {
                    output += `\n[Results truncated: maximum ${maxMatches} matches reached]`;
                }
            }

            return {
                content: output,
            };
        },
    };
};
