import fs from "node:fs/promises";
import path from "node:path";

export const isInsideRoot = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export const isAbsolutePath = (targetPath: string): boolean => {
    return (
        path.isAbsolute(targetPath) ||
        path.posix.isAbsolute(targetPath) ||
        path.win32.isAbsolute(targetPath) ||
        /^[a-zA-Z]:[\\/]/.test(targetPath)
    );
};

export const resolveRepositoryPath = async (repositoryRoot: string, userPath: string) => {
    if (isAbsolutePath(userPath)) {
        throw new Error(
            `Repository path must be relative: "${userPath}". Do not use absolute filesystem paths; provide a path relative to the repository root (e.g. "." or "src/index.ts").`,
        );
    }

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
