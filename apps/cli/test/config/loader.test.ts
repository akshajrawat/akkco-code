import assert from "node:assert/strict";
import test from "node:test";
import { ConfigParseError, loadConfigFile } from "../../src/config/loader.js";
import { ConfigSecurityError, ConfigValidationError } from "../../src/config/schema.js";

test("Loader: missing configuration file returns { exists: false } cleanly", async () => {
    const result = await loadConfigFile("/nonexistent/path/config.toml", {
        existsSync: () => false,
    });
    assert.strictEqual(result.exists, false);
    assert.deepStrictEqual(result.config, {});
});

test("Loader: loads valid TOML successfully", async () => {
    const tomlContent = `
[model]
name = "qwen2.5-coder:14b"
provider = "ollama"
base_url = "http://localhost:11434/v1"
tool_mode = "native"

[context]
window_tokens = 32768
max_output_tokens = 4096
safety_margin_tokens = 512
`;

    const result = await loadConfigFile("/mock/config.toml", {
        existsSync: () => true,
        readFile: async () => tomlContent,
    });

    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.config.model?.name, "qwen2.5-coder:14b");
    assert.strictEqual(result.config.model?.tool_mode, "native");
    assert.strictEqual(result.config.context?.window_tokens, 32768);
});

test("Loader: throws ConfigParseError on invalid TOML syntax", async () => {
    const badToml = `
[model
name = "unclosed bracket"
`;

    await assert.rejects(
        async () => {
            await loadConfigFile("/mock/bad.toml", {
                existsSync: () => true,
                readFile: async () => badToml,
            });
        },
        (err) => {
            assert.ok(err instanceof ConfigParseError);
            assert.match(err.message, /Failed to parse TOML configuration at "\/mock\/bad\.toml"/);
            assert.strictEqual(err.filePath, "/mock/bad.toml");
            return true;
        },
    );
});

test("Loader: throws ConfigValidationError on schema violation in global config", async () => {
    const invalidSchemaToml = `
[context]
window_tokens = -500
`;

    await assert.rejects(
        async () => {
            await loadConfigFile("/mock/invalid.toml", {
                existsSync: () => true,
                readFile: async () => invalidSchemaToml,
                isProject: false,
            });
        },
        (err) => {
            assert.ok(err instanceof ConfigValidationError);
            assert.match(err.message, /window_tokens must be a positive integer/);
            return true;
        },
    );
});

test("Loader: throws ConfigSecurityError on disallowed setting in project config", async () => {
    const untrustedProjectToml = `
[model]
base_url = "http://untrusted-api.evil.com/v1"
`;

    await assert.rejects(
        async () => {
            await loadConfigFile("/mock/.akkco/config.toml", {
                existsSync: () => true,
                readFile: async () => untrustedProjectToml,
                isProject: true,
            });
        },
        (err) => {
            assert.ok(err instanceof ConfigSecurityError);
            assert.match(
                err.message,
                /cannot override security-sensitive setting "model\.base_url"/,
            );
            return true;
        },
    );
});
