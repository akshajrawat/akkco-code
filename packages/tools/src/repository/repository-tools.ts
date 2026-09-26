import { createListFilesTool } from "./filesystem/list-files.js";
import { createReadFileTool } from "./filesystem/read-file.js";
import { createSearchTextTool } from "./filesystem/search-text.js";
import type { AnyToolDefinition } from "../core/types.js";

export const createRepositoryTools = (repositoryRoot: string): AnyToolDefinition[] => [
    createReadFileTool(repositoryRoot),
    createListFilesTool(repositoryRoot),
    createSearchTextTool(repositoryRoot),
];
