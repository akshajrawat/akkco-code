import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelProfile, validateModelProfile, type ModelProfile } from "../src/index.js";

test("ModelProfile: resolves conservative baseline for unknown model", () => {
    const profile = resolveModelProfile("some-custom-model");
    assert.strictEqual(profile.id, "some-custom-model");
    assert.strictEqual(profile.contextWindowTokens, 8192);
    assert.strictEqual(profile.maxOutputTokens, 1024);
    assert.strictEqual(profile.safetyMarginTokens, 256);
    assert.strictEqual(profile.charsPerToken, 4);
    assert.strictEqual(profile.toolMode, "compatibility");
});

test("ModelProfile: resolves known Qwen 2.5 Coder presets", () => {
    const p7b = resolveModelProfile("qwen2.5-coder:7b");
    assert.strictEqual(p7b.contextWindowTokens, 32768);
    assert.strictEqual(p7b.maxOutputTokens, 2048);
    assert.strictEqual(p7b.safetyMarginTokens, 512);
    assert.strictEqual(p7b.toolMode, "compatibility");

    const p3b = resolveModelProfile("qwen2.5-coder:3b");
    assert.strictEqual(p3b.contextWindowTokens, 32768);
});

test("ModelProfile: resolves known Llama 3 and 3.1 presets", () => {
    const pLlama3 = resolveModelProfile("llama3:8b");
    assert.strictEqual(pLlama3.contextWindowTokens, 8192);
    assert.strictEqual(pLlama3.maxOutputTokens, 1024);

    const pLlama31 = resolveModelProfile("llama3.1:8b");
    assert.strictEqual(pLlama31.contextWindowTokens, 32768);
    assert.strictEqual(pLlama31.maxOutputTokens, 2048);
});

test("ModelProfile: explicit overrides take precedence over presets and baseline", () => {
    const profile = resolveModelProfile("qwen2.5-coder:7b", {
        contextWindowTokens: 16384,
        maxOutputTokens: 512,
        toolMode: "native",
        charsPerToken: 3.5,
        backend: "ollama",
    });

    assert.strictEqual(profile.id, "qwen2.5-coder:7b");
    assert.strictEqual(profile.contextWindowTokens, 16384);
    assert.strictEqual(profile.maxOutputTokens, 512);
    assert.strictEqual(profile.safetyMarginTokens, 512); // retained from preset
    assert.strictEqual(profile.toolMode, "native");
    assert.strictEqual(profile.charsPerToken, 3.5);
    assert.strictEqual(profile.backend, "ollama");
});

test("ModelProfile: rejects empty or non-string model ID", () => {
    assert.throws(() => resolveModelProfile(""), {
        name: "TypeError",
    });
    assert.throws(() => resolveModelProfile("   "), {
        name: "TypeError",
    });
    assert.throws(() => resolveModelProfile(null as unknown as string), {
        name: "TypeError",
    });
});

test("ModelProfile: validation rejects non-positive or non-integer contextWindowTokens", () => {
    assert.throws(
        () =>
            validateModelProfile({
                id: "test",
                contextWindowTokens: 0,
                maxOutputTokens: 100,
                toolMode: "native",
            }),
        { name: "RangeError" },
    );

    assert.throws(
        () =>
            validateModelProfile({
                id: "test",
                contextWindowTokens: 1000.5,
                maxOutputTokens: 100,
                toolMode: "native",
            }),
        { name: "RangeError" },
    );
});

test("ModelProfile: validation rejects non-positive or non-integer maxOutputTokens", () => {
    assert.throws(
        () =>
            validateModelProfile({
                id: "test",
                contextWindowTokens: 2000,
                maxOutputTokens: 0,
                toolMode: "native",
            }),
        { name: "RangeError" },
    );

    assert.throws(
        () =>
            validateModelProfile({
                id: "test",
                contextWindowTokens: 2000,
                maxOutputTokens: -10,
                toolMode: "native",
            }),
        { name: "RangeError" },
    );
});

test("ModelProfile: validation rejects negative safetyMarginTokens", () => {
    assert.throws(
        () =>
            validateModelProfile({
                id: "test",
                contextWindowTokens: 2000,
                maxOutputTokens: 100,
                safetyMarginTokens: -1,
                toolMode: "native",
            }),
        { name: "RangeError" },
    );
});

test("ModelProfile: validation rejects non-positive charsPerToken", () => {
    assert.throws(
        () =>
            validateModelProfile({
                id: "test",
                contextWindowTokens: 2000,
                maxOutputTokens: 100,
                charsPerToken: 0,
                toolMode: "native",
            }),
        { name: "RangeError" },
    );
});

test("ModelProfile: validation rejects invalid toolMode", () => {
    assert.throws(
        () =>
            validateModelProfile({
                id: "test",
                contextWindowTokens: 2000,
                maxOutputTokens: 100,
                toolMode: "invalid" as unknown as ModelProfile["toolMode"],
            }),
        { name: "RangeError" },
    );
});

test("ModelProfile: validation rejects zero or negative effective input capacity", () => {
    assert.throws(
        () =>
            validateModelProfile({
                id: "test",
                contextWindowTokens: 1000,
                maxOutputTokens: 900,
                safetyMarginTokens: 100,
                toolMode: "native",
            }),
        { name: "RangeError" },
    );

    assert.throws(
        () =>
            validateModelProfile({
                id: "test",
                contextWindowTokens: 1000,
                maxOutputTokens: 800,
                safetyMarginTokens: 300,
                toolMode: "native",
            }),
        { name: "RangeError" },
    );
});
