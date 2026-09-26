import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSearchTextTool } from "../../src/index.js";

const setupTestRepo = async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "akkco-test-searchtext-"));
    const repoRoot = path.join(tmpDir, "repo");
    const outsideDir = path.join(tmpDir, "outside_dir");

    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret outside target_string");

    const cleanup = async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    };

    return { tmpDir, repoRoot, outsideDir, cleanup };
};

test("search_text finds literal text with correct relative path and line numbers in nested files", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const srcDir = path.join(repoRoot, "src", "nested");
        await fs.mkdir(srcDir, { recursive: true });

        await fs.writeFile(
            path.join(srcDir, "app.ts"),
            "line 1\nline 2: target_pattern\nline 3\nline 4: target_pattern again\n",
            "utf-8"
        );

        const tool = createSearchTextTool(repoRoot);
        const result = await tool.execute({ query: "target_pattern" });

        const expectedLines = [
            "src/nested/app.ts:2:line 2: target_pattern",
            "src/nested/app.ts:4:line 4: target_pattern again",
        ];
        assert.deepStrictEqual(result.content.split("\n"), expectedLines);
    } finally {
        await cleanup();
    }
});

test("search_text respects optional search path", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const pkgA = path.join(repoRoot, "packages", "a");
        const pkgB = path.join(repoRoot, "packages", "b");
        await fs.mkdir(pkgA, { recursive: true });
        await fs.mkdir(pkgB, { recursive: true });

        await fs.writeFile(path.join(pkgA, "file.ts"), "find_me here", "utf-8");
        await fs.writeFile(path.join(pkgB, "file.ts"), "find_me here too", "utf-8");

        const tool = createSearchTextTool(repoRoot);
        const result = await tool.execute({ query: "find_me", path: "packages/a" });

        assert.deepStrictEqual(result.content.split("\n"), [
            "packages/a/file.ts:1:find_me here",
        ]);
    } finally {
        await cleanup();
    }
});

test("search_text ignores node_modules, .git, dist, and build directories", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const nodeModulesDir = path.join(repoRoot, "node_modules", "lib");
        const gitDir = path.join(repoRoot, ".git", "info");
        const distDir = path.join(repoRoot, "dist");
        const buildDir = path.join(repoRoot, "build");
        const srcDir = path.join(repoRoot, "src");

        await fs.mkdir(nodeModulesDir, { recursive: true });
        await fs.mkdir(gitDir, { recursive: true });
        await fs.mkdir(distDir, { recursive: true });
        await fs.mkdir(buildDir, { recursive: true });
        await fs.mkdir(srcDir, { recursive: true });

        await fs.writeFile(path.join(nodeModulesDir, "dep.ts"), "search_keyword", "utf-8");
        await fs.writeFile(path.join(gitDir, "exclude"), "search_keyword", "utf-8");
        await fs.writeFile(path.join(distDir, "bundle.js"), "search_keyword", "utf-8");
        await fs.writeFile(path.join(buildDir, "output.js"), "search_keyword", "utf-8");
        await fs.writeFile(path.join(srcDir, "valid.ts"), "search_keyword in src", "utf-8");

        const tool = createSearchTextTool(repoRoot);
        const result = await tool.execute({ query: "search_keyword" });

        assert.deepStrictEqual(result.content.split("\n"), [
            "src/valid.ts:1:search_keyword in src",
        ]);
    } finally {
        await cleanup();
    }
});

test("search_text returns no-match result cleanly", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        await fs.writeFile(path.join(repoRoot, "sample.txt"), "hello world", "utf-8");

        const tool = createSearchTextTool(repoRoot);
        const result = await tool.execute({ query: "nonexistent_token" });

        assert.strictEqual(result.content, "No matches found.");
    } finally {
        await cleanup();
    }
});

test("search_text enforces result limit and indicates truncation", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const lines = Array.from({ length: 10 }, (_, i) => `item ${i + 1}: match_item`).join("\n");
        await fs.writeFile(path.join(repoRoot, "many.txt"), lines, "utf-8");

        // Set maxMatches to 3
        const tool = createSearchTextTool(repoRoot, 3);
        const result = await tool.execute({ query: "match_item" });

        const resultLines = result.content.split("\n");
        assert.strictEqual(resultLines.length, 4); // 3 matches + 1 truncation line
        assert.strictEqual(resultLines[0], "many.txt:1:item 1: match_item");
        assert.strictEqual(resultLines[1], "many.txt:2:item 2: match_item");
        assert.strictEqual(resultLines[2], "many.txt:3:item 3: match_item");
        assert.match(resultLines[3], /Results truncated: maximum 3 matches reached/);
    } finally {
        await cleanup();
    }
});

test("search_text rejects path traversal escaping root", async () => {
    const { repoRoot, cleanup } = await setupTestRepo();
    try {
        const tool = createSearchTextTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ query: "secret", path: "../outside_dir" });
        }, /escapes repository root/i);
    } finally {
        await cleanup();
    }
});

test("search_text rejects outside symlink", async () => {
    const { repoRoot, outsideDir, cleanup } = await setupTestRepo();
    try {
        const symlinkPath = path.join(repoRoot, "sym_outside");
        await fs.symlink(outsideDir, symlinkPath);

        const tool = createSearchTextTool(repoRoot);

        await assert.rejects(async () => {
            await tool.execute({ query: "secret", path: "sym_outside" });
        }, /escapes repository root via symlink/i);
    } finally {
        await cleanup();
    }
});
