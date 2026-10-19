import assert from "node:assert/strict";
import test from "node:test";
import {
    DEFAULT_MODEL,
    parseCharsPerToken,
    parseContextWindowTokens,
    parseMaxOutputTokens,
    parseMaxToolIterations,
    parseSafetyMarginTokens,
    parseToolMode,
    resolveCliModelProfile,
} from "../src/config.js";

test("CLI Config: parseToolMode respects defaults and explicit overrides", () => {
    assert.strictEqual(parseToolMode(undefined), "compatibility");
    assert.strictEqual(parseToolMode("compatibility"), "compatibility");
    assert.strictEqual(parseToolMode("native"), "native");
    assert.throws(() => parseToolMode("invalid"), /Invalid AKKCO_TOOL_MODE/);
});

test("CLI Config: parseMaxToolIterations validates positive integer", () => {
    assert.strictEqual(parseMaxToolIterations(undefined), undefined);
    assert.strictEqual(parseMaxToolIterations("5"), 5);
    assert.throws(() => parseMaxToolIterations("0"), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
    assert.throws(() => parseMaxToolIterations("-1"), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
    assert.throws(() => parseMaxToolIterations("abc"), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
});

test("CLI Config: parseContextWindowTokens validates positive integer", () => {
    assert.strictEqual(parseContextWindowTokens(undefined), undefined);
    assert.strictEqual(parseContextWindowTokens("16384"), 16384);
    assert.throws(() => parseContextWindowTokens("0"), /Invalid AKKCO_CONTEXT_WINDOW_TOKENS/);
    assert.throws(() => parseContextWindowTokens("-100"), /Invalid AKKCO_CONTEXT_WINDOW_TOKENS/);
    assert.throws(() => parseContextWindowTokens("foo"), /Invalid AKKCO_CONTEXT_WINDOW_TOKENS/);
    assert.throws(() => parseContextWindowTokens("16384.5"), /Invalid AKKCO_CONTEXT_WINDOW_TOKENS/);
});

test("CLI Config: parseMaxOutputTokens validates positive integer", () => {
    assert.strictEqual(parseMaxOutputTokens(undefined), undefined);
    assert.strictEqual(parseMaxOutputTokens("2048"), 2048);
    assert.throws(() => parseMaxOutputTokens("0"), /Invalid AKKCO_MAX_OUTPUT_TOKENS/);
    assert.throws(() => parseMaxOutputTokens("-5"), /Invalid AKKCO_MAX_OUTPUT_TOKENS/);
    assert.throws(() => parseMaxOutputTokens("invalid"), /Invalid AKKCO_MAX_OUTPUT_TOKENS/);
});

test("CLI Config: parseSafetyMarginTokens validates non-negative integer", () => {
    assert.strictEqual(parseSafetyMarginTokens(undefined), undefined);
    assert.strictEqual(parseSafetyMarginTokens("0"), 0);
    assert.strictEqual(parseSafetyMarginTokens("512"), 512);
    assert.throws(() => parseSafetyMarginTokens("-1"), /Invalid AKKCO_SAFETY_MARGIN_TOKENS/);
    assert.throws(() => parseSafetyMarginTokens("abc"), /Invalid AKKCO_SAFETY_MARGIN_TOKENS/);
});

test("CLI Config: parseCharsPerToken validates positive finite number", () => {
    assert.strictEqual(parseCharsPerToken(undefined), undefined);
    assert.strictEqual(parseCharsPerToken("4"), 4);
    assert.strictEqual(parseCharsPerToken("3.5"), 3.5);
    assert.throws(() => parseCharsPerToken("0"), /Invalid AKKCO_CHARS_PER_TOKEN/);
    assert.throws(() => parseCharsPerToken("-2"), /Invalid AKKCO_CHARS_PER_TOKEN/);
    assert.throws(() => parseCharsPerToken("NaN"), /Invalid AKKCO_CHARS_PER_TOKEN/);
});

test("CLI Config: resolveCliModelProfile resolves default model profile", () => {
    const profile = resolveCliModelProfile(DEFAULT_MODEL);
    assert.strictEqual(profile.id, "qwen2.5-coder:7b");
    assert.strictEqual(profile.contextWindowTokens, 32768);
    assert.strictEqual(profile.maxOutputTokens, 2048);
    assert.strictEqual(profile.safetyMarginTokens, 512);
    assert.strictEqual(profile.toolMode, "compatibility");
    assert.strictEqual(profile.charsPerToken, 4);
});

test("CLI Config: resolveCliModelProfile applies validated overrides", () => {
    const profile = resolveCliModelProfile("custom-model", {
        contextWindowTokens: 4096,
        maxOutputTokens: 512,
        safetyMarginTokens: 128,
        toolMode: "native",
        charsPerToken: 3.2,
    });

    assert.strictEqual(profile.id, "custom-model");
    assert.strictEqual(profile.contextWindowTokens, 4096);
    assert.strictEqual(profile.maxOutputTokens, 512);
    assert.strictEqual(profile.safetyMarginTokens, 128);
    assert.strictEqual(profile.toolMode, "native");
    assert.strictEqual(profile.charsPerToken, 3.2);
});

test("CLI Config: resolveCliModelProfile rejects invalid profile combinations", () => {
    assert.throws(
        () =>
            resolveCliModelProfile("small-model", {
                contextWindowTokens: 1000,
                maxOutputTokens: 900,
                safetyMarginTokens: 200,
            }),
        /Effective input capacity.*must be strictly greater than zero/,
    );
});
