import assert from "node:assert/strict";
import test from "node:test";
import {
    GeminiEmbeddingProvider,
    estimateTokensForGemini,
} from "../src/gemini/gemini-embedding-provider.js";

const apiKey = process.env.GEMINI_API_KEY || process.env.AKKCO_GEMINI_API_KEY;

test("Gemini API live smoke test", async (t) => {
    if (!apiKey || !apiKey.trim()) {
        console.log(
            "\n[SMOKE TEST INFO] Neither GEMINI_API_KEY nor AKKCO_GEMINI_API_KEY is set.\n" +
                "To run the live Gemini embedding API smoke test manually against Google AI Studio:\n" +
                "  GEMINI_API_KEY=your_api_key npm run test:gemini-smoke\n",
        );
        t.skip("GEMINI_API_KEY not configured; skipping live network test");
        return;
    }

    // Never log or expose the raw API key
    const maskedKey =
        apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : "[CONFIGURED]";
    console.log(`Running live Gemini smoke test with API key: ${maskedKey}`);

    const provider = new GeminiEmbeddingProvider({
        apiKey,
        model: "gemini-embedding-001",
        dimensions: 768,
        timeoutMs: 15000,
    });

    // 1. Embed standard conversational text
    console.log("1. Testing standard text embedding...");
    const standardInputs = ["Akkco Code is a terminal-based agentic coding assistant."];
    const standardVectors = await provider.embed(standardInputs, undefined, {
        taskType: "RETRIEVAL_DOCUMENT",
    });

    assert.equal(standardVectors.length, 1);
    assert.equal(standardVectors[0].length, 768);
    for (const val of standardVectors[0]) {
        assert.ok(typeof val === "number" && Number.isFinite(val));
    }
    console.log("✔ Standard text embedding returned valid 768-dim vector.");

    // 2. Embed oversized input combining code, CJK, and emoji exceeding 2048 tokens
    console.log("2. Testing oversized input bounding and embedding with code, CJK, and emoji...");
    const headMarker = "SMOKE_HEAD_INTENT: Optimize database indexes for fast prefix queries";
    const tailMarker = "SMOKE_TAIL_RESOLUTION: Applied compound index on (status, created_at)";
    const cjkSection = "用户提问：如何优化大规模嵌入向量的检索性能与内存开销？".repeat(50);
    const emojiSection = "🚀🌟🔥⚡🎉💻🔍".repeat(100);
    const codeSection = `
    async function executeQuery(db: Database, query: string): Promise<QueryResult> {
        const stmt = db.prepare(query);
        return stmt.all();
    }
    `.repeat(40);

    const oversizedInput = `${headMarker}\n${cjkSection}\n${emojiSection}\n${codeSection}\n${tailMarker}`;
    const rawTokens = estimateTokensForGemini(oversizedInput);
    assert.ok(rawTokens > 2048, `Raw input should exceed 2048 tokens (estimated: ${rawTokens})`);

    const bounded = provider.boundInput(oversizedInput);
    const boundedTokens = estimateTokensForGemini(bounded);
    assert.ok(
        boundedTokens <= 2048,
        `Bounded text must satisfy 2048 token budget (got: ${boundedTokens})`,
    );

    const oversizedVectors = await provider.embed([oversizedInput], undefined, {
        taskType: "RETRIEVAL_DOCUMENT",
    });

    assert.equal(oversizedVectors.length, 1);
    assert.equal(oversizedVectors[0].length, 768);
    for (const val of oversizedVectors[0]) {
        assert.ok(typeof val === "number" && Number.isFinite(val));
    }
    console.log("✔ Oversized input was safely bounded and accepted by Gemini API without error.");

    // 3. Security check: verify that errors strictly redact API keys
    console.log("3. Verifying credential protection on error...");
    const dummyKey = "test-fake-key-XYZ123456789ABCDEF";
    const failingProvider = new GeminiEmbeddingProvider({
        apiKey: dummyKey,
        maxRetries: 0,
        timeoutMs: 5000,
    });

    let caughtError: Error | undefined;
    try {
        await failingProvider.embed(["test"]);
    } catch (err) {
        caughtError = err as Error;
    }

    assert.ok(caughtError, "Provider with invalid key must throw");
    assert.equal(
        caughtError.message.includes(dummyKey),
        false,
        "Error message must NEVER expose the raw API key",
    );
    assert.ok(
        caughtError.message.includes("[REDACTED]"),
        "Error message must redact sensitive credentials",
    );
    console.log("✔ Credential redaction confirmed: API key is never exposed.");
});
