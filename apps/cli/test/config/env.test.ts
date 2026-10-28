import assert from "node:assert/strict";
import test from "node:test";
import {
    extractEnvConfig,
    parseCharsPerToken,
    parseConsecutiveToolErrorLimit,
    parseContextWindowTokens,
    parseEmbeddingDimensions,
    parseEmbeddingProvider,
    parseMaxOutputTokens,
    parseMaxToolIterations,
    parseRepeatedToolCallLimit,
    parseSafetyMarginTokens,
    parseToolMode,
} from "../../src/config/env.js";

test("Env: parseRepeatedToolCallLimit and parseConsecutiveToolErrorLimit validate positive integers", () => {
    assert.strictEqual(parseRepeatedToolCallLimit(undefined), undefined);
    assert.strictEqual(parseRepeatedToolCallLimit("3"), 3);
    assert.throws(() => parseRepeatedToolCallLimit("0"), /Invalid AKKCO_REPEATED_TOOL_CALL_LIMIT/);
    assert.throws(() => parseRepeatedToolCallLimit("-1"), /Invalid AKKCO_REPEATED_TOOL_CALL_LIMIT/);
    assert.throws(
        () => parseRepeatedToolCallLimit("abc"),
        /Invalid AKKCO_REPEATED_TOOL_CALL_LIMIT/,
    );

    assert.strictEqual(parseConsecutiveToolErrorLimit(undefined), undefined);
    assert.strictEqual(parseConsecutiveToolErrorLimit("4"), 4);
    assert.throws(
        () => parseConsecutiveToolErrorLimit("0"),
        /Invalid AKKCO_CONSECUTIVE_TOOL_ERROR_LIMIT/,
    );
    assert.throws(
        () => parseConsecutiveToolErrorLimit("-2"),
        /Invalid AKKCO_CONSECUTIVE_TOOL_ERROR_LIMIT/,
    );
    assert.throws(
        () => parseConsecutiveToolErrorLimit("xyz"),
        /Invalid AKKCO_CONSECUTIVE_TOOL_ERROR_LIMIT/,
    );
});

test("Env: extractEnvConfig extracts all supported environment variables cleanly", () => {
    const env: NodeJS.ProcessEnv = {
        AKKCO_MODEL: "custom-model",
        AKKCO_BASE_URL: "http://custom-host:8000/v1",
        AKKCO_TOOL_MODE: "native",
        AKKCO_API_KEY: "secret-key",
        AKKCO_CONTEXT_WINDOW_TOKENS: "16384",
        AKKCO_MAX_OUTPUT_TOKENS: "2048",
        AKKCO_SAFETY_MARGIN_TOKENS: "256",
        AKKCO_CHARS_PER_TOKEN: "3.8",
        AKKCO_MAX_TOOL_ITERATIONS: "35",
        AKKCO_REPEATED_TOOL_CALL_LIMIT: "5",
        AKKCO_CONSECUTIVE_TOOL_ERROR_LIMIT: "3",
        AKKCO_EMBEDDING_PROVIDER: "gemini",
        AKKCO_EMBEDDING_MODEL: "gemini-embedding-001",
        AKKCO_EMBEDDING_DIMENSIONS: "768",
        AKKCO_EMBEDDING_BASE_URL: "https://generativelanguage.googleapis.com",
        AKKCO_EMBEDDING_API_KEY: "emb-key",
    };

    const config = extractEnvConfig(env);

    assert.strictEqual(config.model?.name, "custom-model");
    assert.strictEqual(config.model?.base_url, "http://custom-host:8000/v1");
    assert.strictEqual(config.model?.tool_mode, "native");
    assert.strictEqual(config.model?.api_key, "secret-key");

    assert.strictEqual(config.context?.window_tokens, 16384);
    assert.strictEqual(config.context?.max_output_tokens, 2048);
    assert.strictEqual(config.context?.safety_margin_tokens, 256);
    assert.strictEqual(config.context?.chars_per_token, 3.8);

    assert.strictEqual(config.agent?.max_tool_iterations, 35);
    assert.strictEqual(config.agent?.repeated_tool_call_limit, 5);
    assert.strictEqual(config.agent?.consecutive_tool_error_limit, 3);

    assert.strictEqual(config.embedding?.provider, "gemini");
    assert.strictEqual(config.embedding?.model, "gemini-embedding-001");
    assert.strictEqual(config.embedding?.dimensions, 768);
    assert.strictEqual(config.embedding?.base_url, "https://generativelanguage.googleapis.com");
    assert.strictEqual(config.embedding?.api_key, "emb-key");
});
