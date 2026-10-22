import assert from "node:assert/strict";
import test from "node:test";
import { GeminiEmbeddingProvider, OpenAICompatibleEmbeddingProvider } from "@akkco/providers";
import {
    EmbeddingConfigurationError,
    parseEmbeddingDimensions,
    resolveEmbeddingProvider,
} from "../src/config.js";

test("parseEmbeddingDimensions: strictly validates positive integers", () => {
    assert.equal(parseEmbeddingDimensions(undefined), undefined);
    assert.equal(parseEmbeddingDimensions("768"), 768);
    assert.equal(parseEmbeddingDimensions(" 1536 "), 1536);

    for (const invalid of ["", "   ", "768abc", "abc768", "-5", "0", "1.5", "NaN", "Infinity"]) {
        assert.throws(
            () => parseEmbeddingDimensions(invalid),
            EmbeddingConfigurationError,
            `Expected "${invalid}" to be rejected by strict integer parsing`,
        );
    }
});

test("resolveEmbeddingProvider: AKKCO_EMBEDDING_PROVIDER=gemini selects GeminiEmbeddingProvider with defaults", async () => {
    const provider = await resolveEmbeddingProvider({
        env: {
            AKKCO_EMBEDDING_PROVIDER: "gemini",
            GEMINI_API_KEY: "test-gemini-key",
        },
    });

    assert.ok(provider instanceof GeminiEmbeddingProvider);
    assert.equal(provider.id, "gemini");
    assert.equal(provider.model, "gemini-embedding-001");
    assert.equal(provider.dimensions, 768);
});

test("resolveEmbeddingProvider: throws EmbeddingConfigurationError when GEMINI_API_KEY is missing", async () => {
    await assert.rejects(
        async () => {
            await resolveEmbeddingProvider({
                env: {
                    AKKCO_EMBEDDING_PROVIDER: "gemini",
                },
            });
        },
        (err: unknown) => {
            assert.ok(err instanceof EmbeddingConfigurationError);
            assert.match(
                err.message,
                /GEMINI_API_KEY environment variable is required when AKKCO_EMBEDDING_PROVIDER=gemini/,
            );
            return true;
        },
    );
});

test("resolveEmbeddingProvider: throws EmbeddingConfigurationError on invalid dimensions", async () => {
    for (const invalid of ["768abc", "-1", "0", "invalid"]) {
        await assert.rejects(
            async () => {
                await resolveEmbeddingProvider({
                    env: {
                        AKKCO_EMBEDDING_PROVIDER: "gemini",
                        GEMINI_API_KEY: "test-key",
                        AKKCO_EMBEDDING_DIMENSIONS: invalid,
                    },
                });
            },
            (err: unknown) => {
                assert.ok(err instanceof EmbeddingConfigurationError);
                assert.match(err.message, /Invalid AKKCO_EMBEDDING_DIMENSIONS/);
                return true;
            },
        );
    }
});

test("resolveEmbeddingProvider: throws EmbeddingConfigurationError on unsupported provider", async () => {
    await assert.rejects(
        async () => {
            await resolveEmbeddingProvider({
                env: {
                    AKKCO_EMBEDDING_PROVIDER: "unsupported-provider",
                },
            });
        },
        (err: unknown) => {
            assert.ok(err instanceof EmbeddingConfigurationError);
            assert.match(err.message, /Invalid AKKCO_EMBEDDING_PROVIDER: "unsupported-provider"/);
            return true;
        },
    );
});

test("resolveEmbeddingProvider: GEMINI_API_KEY alone does NOT silently select Gemini", async () => {
    const provider = await resolveEmbeddingProvider({
        env: {
            GEMINI_API_KEY: "some-key",
        },
    });

    assert.equal(
        provider,
        undefined,
        "Cloud embeddings must never be silently selected without explicit AKKCO_EMBEDDING_PROVIDER=gemini",
    );
});

test("resolveEmbeddingProvider: explicit Nomic/local configuration is preserved", async () => {
    const provider = await resolveEmbeddingProvider({
        env: {
            AKKCO_EMBEDDING_MODEL: "nomic-embed-text",
        },
    });

    assert.ok(provider instanceof OpenAICompatibleEmbeddingProvider);
    assert.equal(provider.id, "openai-compatible");
    assert.equal(provider.model, "nomic-embed-text");
});
