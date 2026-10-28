import { createListFilesTool } from "./filesystem/list-files.js";
import { createReadFileTool } from "./filesystem/read-file.js";
import { createSearchTextTool, type SearchTextOptions } from "./filesystem/search-text.js";
import type { AnyToolDefinition } from "../core/types.js";

export interface RepositoryToolsOptions {
    readonly searchText?: SearchTextOptions;
}

export const createRepositoryTools = (
    repositoryRoot: string,
    options?: RepositoryToolsOptions,
): AnyToolDefinition[] => [
    createReadFileTool(repositoryRoot),
    createListFilesTool(repositoryRoot),
    createSearchTextTool(repositoryRoot, options?.searchText),
];
