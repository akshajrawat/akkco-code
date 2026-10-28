import assert from "node:assert/strict";
import test from "node:test";
import {
    ConfigSecurityError,
    ConfigValidationError,
    validateConfig,
    validateProjectConfig,
} from "../../src/config/schema.js";

test("Schema: valid configuration passes validation", () => {
    const valid = {
        model: {
            name: "qwen2.5-coder:7b",
            provider: "ollama",
            base_url: "http://localhost:11434/v1",
            tool_mode: "compatibility",
        },
        context: {
            window_tokens: 32768,
            max_output_tokens: 2048,
            safety_margin_tokens: 512,
            chars_per_token: 4,
        },
        embedding: {
            provider: "gemini",
            model: "gemini-embedding-001",
            dimensions: 768,
            api_key_env: "GEMINI_API_KEY",
        },
        agent: {
            max_tool_iterations: 25,
        },
    };

    const parsed = validateConfig(valid);
    assert.strictEqual(parsed.model?.name, "qwen2.5-coder:7b");
    assert.strictEqual(parsed.context?.window_tokens, 32768);
    assert.strictEqual(parsed.embedding?.dimensions, 768);
    assert.strictEqual(parsed.agent?.max_tool_iterations, 25);
});

test("Schema: rejects unknown configuration sections", () => {
    assert.throws(
        () =>
            validateConfig({
                unknown_section: { foo: "bar" },
            }),
        (err) => {
            assert.ok(err instanceof ConfigValidationError);
            assert.match(err.message, /Unknown section/);
            return true;
        },
    );
});

test("Schema: rejects unknown fields in [model] and [context]", () => {
    assert.throws(
        () =>
            validateConfig({
                model: {
                    name: "qwen2.5-coder:7b",
                    unknown_field: true,
                },
            }),
        (err) => {
            assert.ok(err instanceof ConfigValidationError);
            assert.match(err.message, /Unknown field in \[model\]/);
            return true;
        },
    );

    assert.throws(
        () =>
            validateConfig({
                context: {
                    window_tokens: 8192,
                    unexpected: 123,
                },
            }),
        (err) => {
            assert.ok(err instanceof ConfigValidationError);
            assert.match(err.message, /Unknown field in \[context\]/);
            return true;
        },
    );
});

test("Schema: strictly validates numeric context limits", () => {
    // Zero window_tokens
    assert.throws(
        () => validateConfig({ context: { window_tokens: 0 } }),
        /window_tokens must be a positive integer/,
    );
    // Negative max_output_tokens
    assert.throws(
        () => validateConfig({ context: { max_output_tokens: -1 } }),
        /max_output_tokens must be a positive integer/,
    );
    // Floating point window_tokens
    assert.throws(
        () => validateConfig({ context: { window_tokens: 8192.5 } }),
        /window_tokens must be an integer/,
    );
    // Negative safety margin
    assert.throws(
        () => validateConfig({ context: { safety_margin_tokens: -10 } }),
        /safety_margin_tokens must be a non-negative integer/,
    );
    // Zero safety margin is valid
    const zeroMargin = validateConfig({ context: { safety_margin_tokens: 0 } });
    assert.strictEqual(zeroMargin.context?.safety_margin_tokens, 0);
});

test("Schema: rejects context capacity <= 0", () => {
    assert.throws(
        () =>
            validateConfig({
                context: {
                    window_tokens: 1000,
                    max_output_tokens: 900,
                    safety_margin_tokens: 200,
                },
            }),
        /Effective input capacity.*must be strictly greater than zero/,
    );
});

test("Schema: strictly validates embedding dimensions", () => {
    assert.throws(
        () => validateConfig({ embedding: { dimensions: 0 } }),
        /dimensions must be a positive integer/,
    );
    assert.throws(
        () => validateConfig({ embedding: { dimensions: -768 } }),
        /dimensions must be a positive integer/,
    );
    assert.throws(
        () => validateConfig({ embedding: { dimensions: 768.4 } }),
        /dimensions must be an integer/,
    );
});

test("Schema: project configuration allows safe settings", () => {
    const safeProjectConfig = {
        model: {
            name: "custom-repo-model",
            tool_mode: "native",
        },
        context: {
            window_tokens: 16384,
            max_output_tokens: 1024,
            safety_margin_tokens: 256,
        },
        embedding: {
            model: "nomic-embed-text",
            dimensions: 768,
        },
        agent: {
            max_tool_iterations: 15,
        },
    };

    const validated = validateProjectConfig(safeProjectConfig);
    assert.strictEqual(validated.model?.name, "custom-repo-model");
    assert.strictEqual(validated.model?.tool_mode, "native");
    assert.strictEqual(validated.context?.window_tokens, 16384);
    assert.strictEqual(validated.embedding?.model, "nomic-embed-text");
    assert.strictEqual(validated.agent?.max_tool_iterations, 15);
});

test("Schema: project configuration strictly rejects security-sensitive model.base_url", () => {
    assert.throws(
        () =>
            validateProjectConfig({
                model: {
                    name: "qwen2.5-coder:7b",
                    base_url: "http://malicious-attacker.com/v1",
                },
            }),
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

test("Schema: project configuration strictly rejects security-sensitive embedding.provider", () => {
    assert.throws(
        () =>
            validateProjectConfig({
                embedding: {
                    provider: "gemini",
                },
            }),
        (err) => {
            assert.ok(err instanceof ConfigSecurityError);
            assert.match(
                err.message,
                /cannot override security-sensitive setting "embedding\.provider"/,
            );
            return true;
        },
    );
});

test("Schema: project configuration strictly rejects security-sensitive credentials and endpoints", () => {
    assert.throws(
        () =>
            validateProjectConfig({
                model: {
                    api_key: "stolen-key",
                },
            }),
        (err) => {
            assert.ok(err instanceof ConfigSecurityError);
            assert.match(
                err.message,
                /cannot override security-sensitive setting "model\.api_key"/,
            );
            return true;
        },
    );

    assert.throws(
        () =>
            validateProjectConfig({
                embedding: {
                    base_url: "http://attacker-exfiltration.com",
                },
            }),
        (err) => {
            assert.ok(err instanceof ConfigSecurityError);
            assert.match(
                err.message,
                /cannot override security-sensitive setting "embedding\.base_url"/,
            );
            return true;
        },
    );

    assert.throws(
        () =>
            validateProjectConfig({
                embedding: {
                    api_key_env: "AWS_SECRET_ACCESS_KEY",
                },
            }),
        (err) => {
            assert.ok(err instanceof ConfigSecurityError);
            assert.match(
                err.message,
                /cannot override security-sensitive setting "embedding\.api_key_env"/,
            );
            return true;
        },
    );
});

test("Schema: validates agent reliability limits strictly", () => {
    // Valid agent configuration
    const valid = validateConfig({
        agent: {
            max_tool_iterations: 30,
            repeated_tool_call_limit: 4,
            consecutive_tool_error_limit: 5,
        },
    });
    assert.strictEqual(valid.agent?.max_tool_iterations, 30);
    assert.strictEqual(valid.agent?.repeated_tool_call_limit, 4);
    assert.strictEqual(valid.agent?.consecutive_tool_error_limit, 5);

    // Invalid non-positive
    assert.throws(
        () => validateConfig({ agent: { max_tool_iterations: 0 } }),
        /max_tool_iterations must be a positive integer/,
    );
    assert.throws(
        () => validateConfig({ agent: { repeated_tool_call_limit: -1 } }),
        /repeated_tool_call_limit must be a positive integer/,
    );
    assert.throws(
        () => validateConfig({ agent: { consecutive_tool_error_limit: 1.5 } }),
        /consecutive_tool_error_limit must be an integer/,
    );

    // Allowed in project config
    const proj = validateProjectConfig({
        agent: {
            max_tool_iterations: 15,
            repeated_tool_call_limit: 2,
            consecutive_tool_error_limit: 3,
        },
    });
    assert.strictEqual(proj.agent?.max_tool_iterations, 15);
    assert.strictEqual(proj.agent?.repeated_tool_call_limit, 2);
    assert.strictEqual(proj.agent?.consecutive_tool_error_limit, 3);
});
