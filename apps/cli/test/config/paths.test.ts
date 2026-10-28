import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { findRepositoryRoot, resolveConfigPaths } from "../../src/config/paths.js";

test("Paths: resolves Linux/WSL paths with default XDG", () => {
    const paths = resolveConfigPaths({
        platform: "linux",
        homedir: "/home/user",
        env: {},
        cwd: "/home/user/project",
        existsSync: () => false,
    });

    assert.strictEqual(paths.globalDir, "/home/user/.config/akkco");
    assert.strictEqual(paths.globalConfig, "/home/user/.config/akkco/config.toml");
    assert.strictEqual(paths.credentialsFile, "/home/user/.config/akkco/credentials.env");
});

test("Paths: resolves Linux/WSL paths with explicit XDG_CONFIG_HOME", () => {
    const paths = resolveConfigPaths({
        platform: "linux",
        homedir: "/home/user",
        env: { XDG_CONFIG_HOME: "/custom/config" },
        cwd: "/home/user/project",
        existsSync: () => false,
    });

    assert.strictEqual(paths.globalDir, "/custom/config/akkco");
    assert.strictEqual(paths.globalConfig, "/custom/config/akkco/config.toml");
    assert.strictEqual(paths.credentialsFile, "/custom/config/akkco/credentials.env");
});

test("Paths: resolves macOS paths to ~/Library/Application Support/akkco by default", () => {
    const paths = resolveConfigPaths({
        platform: "darwin",
        homedir: "/Users/user",
        env: {},
        cwd: "/Users/user/project",
        existsSync: () => false,
    });

    assert.strictEqual(paths.globalDir, "/Users/user/Library/Application Support/akkco");
    assert.strictEqual(
        paths.globalConfig,
        "/Users/user/Library/Application Support/akkco/config.toml",
    );
    assert.strictEqual(
        paths.credentialsFile,
        "/Users/user/Library/Application Support/akkco/credentials.env",
    );
});

test("Paths: resolves macOS paths with explicit XDG_CONFIG_HOME", () => {
    const paths = resolveConfigPaths({
        platform: "darwin",
        homedir: "/Users/user",
        env: { XDG_CONFIG_HOME: "/Users/user/.config" },
        cwd: "/Users/user/project",
        existsSync: () => false,
    });

    assert.strictEqual(paths.globalDir, "/Users/user/.config/akkco");
});

test("Paths: resolves Windows paths using %APPDATA%", () => {
    const paths = resolveConfigPaths({
        platform: "win32",
        homedir: "C:\\Users\\user",
        env: { APPDATA: "C:\\Users\\user\\AppData\\Roaming" },
        cwd: "C:\\Users\\user\\project",
        existsSync: () => false,
    });

    assert.strictEqual(
        paths.globalDir,
        path.win32.join("C:\\Users\\user\\AppData\\Roaming", "akkco"),
    );
    assert.strictEqual(
        paths.globalConfig,
        path.win32.join("C:\\Users\\user\\AppData\\Roaming", "akkco", "config.toml"),
    );
    assert.strictEqual(
        paths.credentialsFile,
        path.win32.join("C:\\Users\\user\\AppData\\Roaming", "akkco", "credentials.env"),
    );
});

test("Paths: resolves Windows fallback when APPDATA is unset", () => {
    const paths = resolveConfigPaths({
        platform: "win32",
        homedir: "C:\\Users\\user",
        env: { USERPROFILE: "C:\\Users\\user" },
        cwd: "C:\\Users\\user\\project",
        existsSync: () => false,
    });

    assert.strictEqual(
        paths.globalDir,
        path.win32.join("C:\\Users\\user", "AppData", "Roaming", "akkco"),
    );
});

test("Paths: findRepositoryRoot detects upward .git directory", () => {
    const mockFs = new Set(["/workspace/repo/.git"]);
    const root = findRepositoryRoot("/workspace/repo/packages/core", (p) => mockFs.has(p));
    assert.strictEqual(root, "/workspace/repo");
});

test("Paths: findRepositoryRoot detects upward .akkco configuration directory", () => {
    const mockFs = new Set(["/workspace/project/.akkco"]);
    const root = findRepositoryRoot("/workspace/project/src/sub", (p) => mockFs.has(p));
    assert.strictEqual(root, "/workspace/project");
});

test("Paths: findRepositoryRoot falls back to startDir when no root marker found", () => {
    const root = findRepositoryRoot("/some/isolated/dir", () => false);
    assert.strictEqual(root, "/some/isolated/dir");
});

test("Paths: environment variables AKKCO_GLOBAL_CONFIG and AKKCO_PROJECT_CONFIG override defaults", () => {
    const paths = resolveConfigPaths({
        env: {
            AKKCO_GLOBAL_CONFIG: "/custom/global.toml",
            AKKCO_CREDENTIALS_FILE: "/custom/creds.env",
            AKKCO_PROJECT_CONFIG: "/custom/project/.akkco/config.toml",
        },
    });

    assert.strictEqual(paths.globalConfig, path.resolve("/custom/global.toml"));
    assert.strictEqual(paths.credentialsFile, path.resolve("/custom/creds.env"));
    assert.strictEqual(paths.projectConfig, path.resolve("/custom/project/.akkco/config.toml"));
});
