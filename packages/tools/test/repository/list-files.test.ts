import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createListFilesTool } from "../../src/index.js";

const setupTestRepo = async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-test-listfiles-"));
    const repoRoot = path.join(tmpDir, "repo");
    const outsideDir = path.join(tmpDir, "outside_dir");

    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret");

    const cleanup = async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    };

    return { tmpDir, repoRoot, outsideDir, cleanup };
};

test("list_files lists repository root by default", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        await fs.writeFile(path.join(repoRoot, "root.txt"), "root file");
        await fs.mkdir(path.join(repoRoot, "src"));

        const tool = createListFilesTool(repoRoot);
        const result = await tool.execute({});

        assert.deepStrictEqual(result.content.split("\n"), ["root.txt", "src/"]);
    } finally {
        await cleanup();
    }
});

test("list_files lists nested directory with repository-relative paths", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const srcDir = path.join(repoRoot, "packages", "core");
        await fs.mkdir(srcDir, { recursive: true });
        await fs.writeFile(path.join(srcDir, "index.ts"), "export {}");
        await fs.mkdir(path.join(srcDir, "nested"));

        const tool = createListFilesTool(repoRoot);
        const result = await tool.execute({ path: "packages/core" });

        assert.deepStrictEqual(result.content.split("\n"), [
            "packages/core/index.ts",
            "packages/core/nested/",
        ]);
    } finally {
        await cleanup();
    }
});

test("list_files returns deterministically sorted entries", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        await fs.writeFile(path.join(repoRoot, "z.txt"), "");
        await fs.writeFile(path.join(repoRoot, "a.txt"), "");
        await fs.writeFile(path.join(repoRoot, "m.txt"), "");
        await fs.mkdir(path.join(repoRoot, "b_dir"));

        const tool = createListFilesTool(repoRoot);
        const result = await tool.execute({});

        const lines = result.content.split("\n");
        assert.deepStrictEqual(lines, ["a.txt", "b_dir/", "m.txt", "z.txt"]);
    } finally {
        await cleanup();
    }
});

test("list_files rejects file when directory expected", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const filePath = path.join(repoRoot, "file.txt");
        await fs.writeFile(filePath, "data");

        const tool = createListFilesTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ path: "file.txt" });
        }, /not a directory/i);
    } finally {
        await cleanup();
    }
});

test("list_files rejects path traversal escaping root", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const tool = createListFilesTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ path: "../outside_dir" });
        }, /escapes repository root/i);
    } finally {
        await cleanup();
    }
});

test("list_files rejects outside symlink", async () => {
    const { repoRoot, outsideDir, cleanup } = await setupTestRepo();
    try {
        const symlinkPath = path.join(repoRoot, "sym_outside");
        await fs.symlink(outsideDir, symlinkPath);

        const tool = createListFilesTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ path: "sym_outside" });
        }, /escapes repository root via symlink/i);
    } finally {
        await cleanup();
    }
});

test("list_files rejects an absolute outside path", async () => {
    const { repoRoot, outsideDir, cleanup } = await setupTestRepo();
    try {
        const tool = createListFilesTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ path: outsideDir });
        }, /Repository path must be relative/i);
    } finally {
        await cleanup();
    }
});

test("list_files rejects an absolute path within repository root", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const tool = createListFilesTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ path: repoRoot });
        }, /Repository path must be relative/i);
    } finally {
        await cleanup();
    }
});

test("list_files rejects Windows-style absolute drive path", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const tool = createListFilesTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ path: "C:\\repo" });
        }, /Repository path must be relative/i);

        await assert.rejects(async () => {
            await tool.execute({ path: "D:/repo" });
        }, /Repository path must be relative/i);
    } finally {
        await cleanup();
    }
});
