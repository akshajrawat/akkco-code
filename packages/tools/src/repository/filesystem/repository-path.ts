import fs from "node:fs/promises";
import path from "node:path";

export const isInsideRoot = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export const resolveRepositoryPath = async (repositoryRoot: string, userPath: string) => {
    // e.g. repositoryRoot "./my-repo" -> canonicalRoot "/home/user/my-repo" (symlinks resolved)
    const canonicalRoot = await fs.realpath(path.resolve(repositoryRoot));
    // e.g. userPath "src/index.ts" -> resolvedPath "/home/user/my-repo/src/index.ts"
    const resolvedPath = path.resolve(canonicalRoot, userPath);

    if (!isInsideRoot(canonicalRoot, resolvedPath)) {
        throw new Error(`Path escapes repository root: ${userPath}`);
    }

    const realPath = await fs.realpath(resolvedPath);
    if (!isInsideRoot(canonicalRoot, realPath)) {
        throw new Error(`Path escapes repository root via symlink: ${userPath}`);
    }

    return realPath;
};
