import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigPaths } from "./types.js";

export interface PathResolutionOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly homedir?: string;
    readonly cwd?: string;
    readonly globalConfigPath?: string;
    readonly projectConfigPath?: string;
    readonly credentialsPath?: string;
    readonly existsSync?: (p: string) => boolean;
}

/**
 * Searches upward from startDir to discover the repository root.
 * Detects .git (directory or file) or an existing .akkco configuration directory.
 * Falls back to startDir if no repository indicator is found.
 */
export const findRepositoryRoot = (
    startDir: string,
    existsSync: (p: string) => boolean = fs.existsSync,
): string => {
    let current = path.resolve(startDir);
    const { root } = path.parse(current);

    while (true) {
        const gitPath = path.join(current, ".git");
        const akkcoPath = path.join(current, ".akkco");

        if (existsSync(gitPath) || existsSync(akkcoPath)) {
            return current;
        }

        if (current === root) {
            break;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return path.resolve(startDir);
};

/**
 * Resolves standard global, credential, and project configuration paths
 * across Linux/WSL, macOS, and Windows.
 */
export const resolveConfigPaths = (options?: PathResolutionOptions): ConfigPaths => {
    const env = options?.env ?? process.env;
    const platform = options?.platform ?? process.platform;
    const homedir = options?.homedir ?? os.homedir();
    const cwd = options?.cwd ?? process.cwd();
    const existsSync = options?.existsSync ?? fs.existsSync;
    const pathModule = platform === "win32" ? path.win32 : path.posix;

    let globalDir: string;

    if (env.AKKCO_GLOBAL_CONFIG_DIR) {
        globalDir = pathModule.resolve(env.AKKCO_GLOBAL_CONFIG_DIR);
    } else if (platform === "win32") {
        const appData =
            env.APPDATA ||
            (env.USERPROFILE ? pathModule.join(env.USERPROFILE, "AppData", "Roaming") : undefined);
        globalDir = appData
            ? pathModule.join(appData, "akkco")
            : pathModule.join(homedir, ".config", "akkco");
    } else if (platform === "darwin") {
        if (env.XDG_CONFIG_HOME) {
            globalDir = pathModule.join(env.XDG_CONFIG_HOME, "akkco");
        } else {
            globalDir = pathModule.join(homedir, "Library", "Application Support", "akkco");
        }
    } else {
        // Linux, WSL, and POSIX
        const xdgConfig = env.XDG_CONFIG_HOME || pathModule.join(homedir, ".config");
        globalDir = pathModule.join(xdgConfig, "akkco");
    }

    const globalConfig =
        options?.globalConfigPath ??
        (env.AKKCO_GLOBAL_CONFIG
            ? pathModule.resolve(env.AKKCO_GLOBAL_CONFIG)
            : pathModule.join(globalDir, "config.toml"));

    const credentialsFile =
        options?.credentialsPath ??
        (env.AKKCO_CREDENTIALS_FILE
            ? pathModule.resolve(env.AKKCO_CREDENTIALS_FILE)
            : pathModule.join(globalDir, "credentials.env"));

    let repoRoot: string | undefined;
    let projectDir: string | undefined;
    let projectConfig: string | undefined;

    if (options?.projectConfigPath) {
        projectConfig = options.projectConfigPath;
        projectDir = pathModule.dirname(projectConfig);
        repoRoot = pathModule.dirname(projectDir);
    } else if (env.AKKCO_PROJECT_CONFIG) {
        projectConfig = pathModule.resolve(env.AKKCO_PROJECT_CONFIG);
        projectDir = pathModule.dirname(projectConfig);
        repoRoot = pathModule.dirname(projectDir);
    } else {
        repoRoot = findRepositoryRoot(cwd, existsSync);
        projectDir = pathModule.join(repoRoot, ".akkco");
        projectConfig = pathModule.join(projectDir, "config.toml");
    }

    return {
        globalDir,
        globalConfig,
        credentialsFile,
        repoRoot,
        projectDir,
        projectConfig,
    };
};
