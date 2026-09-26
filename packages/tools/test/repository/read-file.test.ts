import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReadFileTool } from "../../src/index.js";

const setupTestRepo = async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-test-repo-"));
    const repoRoot = path.join(tmpDir, "repo");
    const outsideDir = path.join(tmpDir, "outside");

    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    const outsideFile = path.join(outsideDir, "secret.txt");
    await fs.writeFile(outsideFile, "secret outside content", "utf-8");

    const cleanup = async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    };

    return { tmpDir, repoRoot, outsideFile, cleanup };
};

test("read_file reads a normal repository file", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const filePath = path.join(repoRoot, "sample.txt");
        await fs.writeFile(filePath, "Hello from repo!", "utf-8");

        const tool = createReadFileTool(repoRoot);
        const result = await tool.execute({ path: "sample.txt" });

        assert.deepStrictEqual(result, { content: "Hello from repo!" });
    } finally {
        await cleanup();
    }
});

test("read_file allows normal nested files inside repo", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const nestedDir = path.join(repoRoot, "src", "nested");
        await fs.mkdir(nestedDir, { recursive: true });
        await fs.writeFile(path.join(nestedDir, "deep.txt"), "deep nested data", "utf-8");

        const tool = createReadFileTool(repoRoot);
        const result = await tool.execute({ path: "src/nested/deep.txt" });

        assert.deepStrictEqual(result, { content: "deep nested data" });
    } finally {
        await cleanup();
    }
});

test("read_file rejects ../ path traversal outside root", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const tool = createReadFileTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ path: "../outside/secret.txt" });
        }, /escapes repository root/i);

        await assert.rejects(async () => {
            await tool.execute({ path: "subdir/../../outside/secret.txt" });
        }, /escapes repository root/i);
    } finally {
        await cleanup();
    }
});

test("read_file rejects an absolute outside path", async () => {
    const { repoRoot, outsideFile, cleanup } = await setupTestRepo();
    try {
        const tool = createReadFileTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ path: outsideFile });
        }, /escapes repository root/i);
    } finally {
        await cleanup();
    }
});

test("read_file rejects a directory", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const dirPath = path.join(repoRoot, "docs");
        await fs.mkdir(dirPath, { recursive: true });

        const tool = createReadFileTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ path: "docs" });
        }, /directory/i);
    } finally {
        await cleanup();
    }
});

test("read_file rejects a symlink inside repo pointing to a file outside repo", async () => {
    const { repoRoot, outsideFile, cleanup } = await setupTestRepo();
    try {
        const symlinkPath = path.join(repoRoot, "symlink_escape.txt");
        await fs.symlink(outsideFile, symlinkPath);

        const tool = createReadFileTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ path: "symlink_escape.txt" });
        }, /escapes repository root via symlink/i);
    } finally {
        await cleanup();
    }
});

test("read_file allows a symlink inside repo pointing to a file inside repo", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const targetPath = path.join(repoRoot, "actual.txt");
        await fs.writeFile(targetPath, "internal symlink target", "utf-8");

        const symlinkPath = path.join(repoRoot, "internal_symlink.txt");
        await fs.symlink(targetPath, symlinkPath);

        const tool = createReadFileTool(repoRoot);
        const result = await tool.execute({ path: "internal_symlink.txt" });

        assert.deepStrictEqual(result, { content: "internal symlink target" });
    } finally {
        await cleanup();
    }
});
