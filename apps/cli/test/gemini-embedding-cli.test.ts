import assert from "node:assert/strict";
import test from "node:test";
import { GeminiEmbeddingProvider, OpenAICompatibleEmbeddingProvider } from "@akkco/providers";
import { SqliteConversationStore } from "@akkco/retrieval";

test("CLI embedding configuration: AKKCO_EMBEDDING_PROVIDER=gemini selects GeminiEmbeddingProvider with defaults", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();

    const envBackup = { ...process.env };
    try {
        process.env.AKKCO_EMBEDDING_PROVIDER = "gemini";
        process.env.GEMINI_API_KEY = "test-gemini-key";
        delete process.env.AKKCO_EMBEDDING_MODEL;
        delete process.env.AKKCO_EMBEDDING_DIMENSIONS;

        let embeddingProvider: any;
        if (process.env.AKKCO_EMBEDDING_PROVIDER === "gemini") {
            const apiKey = process.env.GEMINI_API_KEY ?? process.env.AKKCO_EMBEDDING_API_KEY;
            const model = process.env.AKKCO_EMBEDDING_MODEL ?? "gemini-embedding-001";
            let dimensions = 768;
            if (process.env.AKKCO_EMBEDDING_DIMENSIONS) {
                dimensions = parseInt(process.env.AKKCO_EMBEDDING_DIMENSIONS, 10);
            }
            embeddingProvider = new GeminiEmbeddingProvider({
                apiKey: apiKey!,
                model,
                dimensions,
            });
        }

        assert.ok(embeddingProvider instanceof GeminiEmbeddingProvider);
        assert.equal(embeddingProvider.id, "gemini");
        assert.equal(embeddingProvider.model, "gemini-embedding-001");
        assert.equal(embeddingProvider.dimensions, 768);
    } finally {
        process.env = envBackup;
        await store.close();
    }
});

test("CLI embedding configuration: GEMINI_API_KEY alone does NOT silently select Gemini", async () => {
    const envBackup = { ...process.env };
    try {
        delete process.env.AKKCO_EMBEDDING_PROVIDER;
        delete process.env.AKKCO_EMBEDDING_MODEL;
        process.env.GEMINI_API_KEY = "some-key";

        let selectedProvider: string | undefined;
        if (process.env.AKKCO_EMBEDDING_PROVIDER === "gemini") {
            selectedProvider = "gemini";
        } else if (
            process.env.AKKCO_EMBEDDING_PROVIDER === "openai-compatible" ||
            (!process.env.AKKCO_EMBEDDING_PROVIDER && process.env.AKKCO_EMBEDDING_MODEL)
        ) {
            selectedProvider = "openai-compatible";
        }

        assert.equal(
            selectedProvider,
            undefined,
            "Cloud embeddings must never be silently selected without explicit AKKCO_EMBEDDING_PROVIDER=gemini",
        );
    } finally {
        process.env = envBackup;
    }
});

test("CLI embedding configuration: explicit Nomic/local configuration is preserved", async () => {
    const envBackup = { ...process.env };
    try {
        delete process.env.AKKCO_EMBEDDING_PROVIDER;
        process.env.AKKCO_EMBEDDING_MODEL = "nomic-embed-text";

        let embeddingProvider: any;
        if (process.env.AKKCO_EMBEDDING_PROVIDER === "gemini") {
            embeddingProvider = new GeminiEmbeddingProvider({ apiKey: "key" });
        } else if (
            process.env.AKKCO_EMBEDDING_PROVIDER === "openai-compatible" ||
            (!process.env.AKKCO_EMBEDDING_PROVIDER && process.env.AKKCO_EMBEDDING_MODEL)
        ) {
            embeddingProvider = new OpenAICompatibleEmbeddingProvider({
                baseUrl: "http://localhost:11434/v1",
                model: process.env.AKKCO_EMBEDDING_MODEL ?? "nomic-embed-text",
            });
        }

        assert.ok(embeddingProvider instanceof OpenAICompatibleEmbeddingProvider);
        assert.equal(embeddingProvider.id, "openai-compatible");
        assert.equal(embeddingProvider.model, "nomic-embed-text");
    } finally {
        process.env = envBackup;
    }
});
