import assert from "node:assert/strict";
import test from "node:test";
import {
    GeminiEmbeddingProvider,
    estimateTokensForGemini,
} from "../src/gemini/gemini-embedding-provider.js";

const create768Vector = (seed: number): number[] => {
    const vec = new Array(768);
    for (let i = 0; i < 768; i++) {
        vec[i] = Math.sin(seed + i * 0.01);
    }
    return vec;
};

test("GeminiEmbeddingProvider: returns empty array for empty inputs without calling fetch", async () => {
    let fetchCalled = false;
    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-api-key",
        fetch: async () => {
            fetchCalled = true;
            return new Response();
        },
    });

    const res = await provider.embed([]);
    assert.deepEqual(res, []);
    assert.equal(fetchCalled, false);
});

test("GeminiEmbeddingProvider: constructor validates apiKey, dimensions, and model", () => {
    assert.throws(() => new GeminiEmbeddingProvider({ apiKey: "" }), /Gemini API key is required/);
    assert.throws(
        () => new GeminiEmbeddingProvider({ apiKey: "   " }),
        /Gemini API key is required/,
    );
    assert.throws(
        () => new GeminiEmbeddingProvider({ apiKey: "key", model: "" }),
        /Gemini embedding model name must not be empty/,
    );
    assert.throws(
        () => new GeminiEmbeddingProvider({ apiKey: "key", dimensions: -5 }),
        /Gemini embedding dimensions must be a positive integer/,
    );
    assert.throws(
        () => new GeminiEmbeddingProvider({ apiKey: "key", dimensions: 768.5 }),
        /Gemini embedding dimensions must be a positive integer/,
    );

    const defaultProvider = new GeminiEmbeddingProvider({ apiKey: "key" });
    assert.equal(defaultProvider.id, "gemini");
    assert.equal(defaultProvider.model, "gemini-embedding-001");
    assert.equal(defaultProvider.dimensions, 768);
});

test("GeminiEmbeddingProvider: embeds single input with 768 dimensions and x-goog-api-key header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any;

    const mockVec = create768Vector(1);

    const provider = new GeminiEmbeddingProvider({
        apiKey: "secret-key-12345",
        baseUrl: "https://generativelanguage.googleapis.com",
        fetch: async (url, init) => {
            capturedUrl = String(url);
            capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
            capturedBody = JSON.parse(init?.body as string);

            return new Response(
                JSON.stringify({
                    embeddings: [{ values: mockVec }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    const res = await provider.embed(["test input"]);

    assert.equal(res.length, 1);
    assert.equal(res[0].length, 768);
    assert.deepEqual(res[0], mockVec);

    assert.equal(
        capturedUrl,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
    assert.equal(capturedHeaders["x-goog-api-key"], "secret-key-12345");
    assert.equal(capturedHeaders["Content-Type"], "application/json");

    assert.deepEqual(capturedBody, {
        requests: [
            {
                model: "models/gemini-embedding-001",
                content: { parts: [{ text: "test input" }] },
                outputDimensionality: 768,
            },
        ],
    });
});

test("GeminiEmbeddingProvider: supports custom dimensions and taskType", async () => {
    let capturedBody: any;
    const mockVec = new Array(512).fill(0.123);

    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        dimensions: 512,
        taskType: "SEMANTIC_SIMILARITY",
        fetch: async (_url, init) => {
            capturedBody = JSON.parse(init?.body as string);
            return new Response(
                JSON.stringify({
                    embeddings: [{ values: mockVec }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    const res = await provider.embed(["query text"], undefined, {
        taskType: "RETRIEVAL_QUERY",
        title: "Test Title",
    });

    assert.equal(res.length, 1);
    assert.equal(res[0].length, 512);
    assert.equal(capturedBody.requests[0].outputDimensionality, 512);
    assert.equal(capturedBody.requests[0].taskType, "RETRIEVAL_QUERY");
    assert.equal(capturedBody.requests[0].title, "Test Title");
});

test("GeminiEmbeddingProvider: handles batches exceeding 100 items with ordering preserved", async () => {
    const inputCount = 150;
    const inputs = Array.from({ length: inputCount }, (_, i) => `Item ${i}`);
    const fetchCalls: any[] = [];

    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        fetch: async (url, init) => {
            const body = JSON.parse(init?.body as string);
            fetchCalls.push({ url, body });

            const embeddings = body.requests.map((r: any) => {
                const text = r.content.parts[0].text;
                const idx = parseInt(text.replace("Item ", ""), 10);
                return { values: create768Vector(idx) };
            });

            return new Response(JSON.stringify({ embeddings }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        },
    });

    const results = await provider.embed(inputs);

    assert.equal(results.length, 150);
    assert.equal(fetchCalls.length, 2); // 100 + 50
    assert.equal(fetchCalls[0].body.requests.length, 100);
    assert.equal(fetchCalls[1].body.requests.length, 50);

    for (let i = 0; i < 150; i++) {
        assert.deepEqual(results[i], create768Vector(i));
    }
});

test("GeminiEmbeddingProvider: input within maxInputTokens (2048) is sent untruncated", async () => {
    let capturedBody: any;
    const normalText = "function add(a: number, b: number): number {\n    return a + b;\n}";

    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        maxInputTokens: 2048,
        fetch: async (_url, init) => {
            capturedBody = JSON.parse(init?.body as string);
            return new Response(
                JSON.stringify({
                    embeddings: [{ values: create768Vector(1) }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    await provider.embed([normalText]);

    const sentText = capturedBody.requests[0].content.parts[0].text;
    assert.equal(sentText, normalText);
    assert.equal(capturedBody.requests[0].autoTruncate, undefined);
});

test("GeminiEmbeddingProvider: large input exceeding maxInputTokens bounds text preserving head and tail with explicit delimiter", async () => {
    let capturedBody: any;
    // Generate large text with distinct head and tail (> 2048 tokens, ~10000 chars)
    const headMarker = "START_OF_PROMPT_INTENT: How to optimize database queries?";
    const tailMarker = "END_OF_ANSWER_RESOLUTION: Use compound index on (status, created_at).";
    const middleFiller = "Repeated middle content with details.\n".repeat(300);
    const largeText = `${headMarker}\n${middleFiller}\n${tailMarker}`;

    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        maxInputTokens: 2048,
        fetch: async (_url, init) => {
            capturedBody = JSON.parse(init?.body as string);
            return new Response(
                JSON.stringify({
                    embeddings: [{ values: create768Vector(1) }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    await provider.embed([largeText]);

    const sentText = capturedBody.requests[0].content.parts[0].text;
    assert.ok(sentText.includes("START_OF_PROMPT_INTENT"), "Must preserve head intent");
    assert.ok(sentText.includes("END_OF_ANSWER_RESOLUTION"), "Must preserve tail resolution");
    assert.ok(
        sentText.includes("[... content truncated for embedding: exceeds 2048 token limit ...]"),
        "Must include explicit truncation indicator rather than silent truncation",
    );
    assert.equal(capturedBody.requests[0].autoTruncate, undefined);
    assert.ok(provider.boundInput(largeText).length <= largeText.length);
});

test("GeminiEmbeddingProvider: Unicode and multi-byte surrogate pairs are never split into lone surrogates", async () => {
    let capturedBody: any;
    // Generate text with 4-byte UTF-16 surrogate pairs (emojis) and CJK characters
    const emojis = "🚀🌟🔥⚡🎉💻🔍".repeat(1500);
    const unicodeText = `User intent with emojis: ${emojis}\nFinal answer: All tests passed! 🎯`;

    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        maxInputTokens: 2048,
        fetch: async (_url, init) => {
            capturedBody = JSON.parse(init?.body as string);
            return new Response(
                JSON.stringify({
                    embeddings: [{ values: create768Vector(1) }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    await provider.embed([unicodeText]);

    const sentText = capturedBody.requests[0].content.parts[0].text as string;
    // Lone high surrogate: \uD800-\uDBFF not followed by low surrogate \uDC00-\uDFFF
    // Lone low surrogate: \uDC00-\uDFFF not preceded by high surrogate \uD800-\uDBFF
    const loneSurrogateRegex =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    assert.equal(
        loneSurrogateRegex.test(sentText),
        false,
        "Bounding must never split surrogate pairs into invalid Unicode",
    );
    assert.ok(sentText.includes("User intent with emojis"));
    assert.ok(sentText.includes("All tests passed! 🎯"));
});

test("GeminiEmbeddingProvider: code-heavy text with punctuation and indentation is accurately estimated and safely bounded", async () => {
    let capturedBody: any;
    const codeLines: string[] = [];
    codeLines.push("// Entrypoint: database migration runner");
    for (let i = 0; i < 300; i++) {
        codeLines.push(`    if (row.sequence === ${i}) {`);
        codeLines.push(
            `        await db.execute("UPDATE items SET val = ? WHERE id = ?", [${i}, "item-${i}"]);`,
        );
        codeLines.push(`    }`);
    }
    codeLines.push("// Final line: return success status");
    const codeText = codeLines.join("\n");

    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        maxInputTokens: 2048,
        fetch: async (_url, init) => {
            capturedBody = JSON.parse(init?.body as string);
            return new Response(
                JSON.stringify({
                    embeddings: [{ values: create768Vector(1) }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    await provider.embed([codeText]);

    const sentText = capturedBody.requests[0].content.parts[0].text;
    assert.ok(sentText.includes("Entrypoint: database migration runner"));
    assert.ok(sentText.includes("Final line: return success status"));
    assert.ok(
        sentText.includes("[... content truncated for embedding: exceeds 2048 token limit ...]"),
    );
});

test("GeminiEmbeddingProvider: redacts API key from error messages", async () => {
    const apiKey = "super-secret-gemini-key-99999";
    const provider = new GeminiEmbeddingProvider({
        apiKey,
        maxRetries: 0,
        fetch: async () => {
            return new Response(
                JSON.stringify({
                    error: {
                        code: 400,
                        message: `Invalid key provided: ${apiKey} not found`,
                        status: "INVALID_ARGUMENT",
                    },
                }),
                { status: 400, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    try {
        await provider.embed(["test"]);
        assert.fail("Should have thrown error");
    } catch (err) {
        const error = err as Error;
        assert.ok(!error.message.includes(apiKey), "Error message must not contain the API key");
        assert.ok(error.message.includes("[REDACTED]"), "API key should be redacted");
    }
});

test("GeminiEmbeddingProvider: non-retryable errors (400, 403) fail immediately without retries", async () => {
    let callCount = 0;
    const provider = new GeminiEmbeddingProvider({
        apiKey: "key",
        maxRetries: 3,
        fetch: async () => {
            callCount++;
            return new Response("Permission denied", { status: 403 });
        },
    });

    await assert.rejects(async () => {
        await provider.embed(["test"]);
    }, /Gemini embedding request failed with status 403/);

    assert.equal(callCount, 1); // No retries for 403
});

test("GeminiEmbeddingProvider: retries on 429 quota failure and throws after maxRetries", async () => {
    let callCount = 0;
    const provider = new GeminiEmbeddingProvider({
        apiKey: "key",
        maxRetries: 2,
        fetch: async () => {
            callCount++;
            return new Response(
                JSON.stringify({
                    error: {
                        code: 429,
                        message: "Quota exceeded for quota metric 'EmbedContent requests'",
                    },
                }),
                {
                    status: 429,
                    headers: { "Content-Type": "application/json", "retry-after": "0" },
                },
            );
        },
    });

    await assert.rejects(async () => {
        await provider.embed(["test"]);
    }, /Gemini embedding request failed with status 429: Quota exceeded/);

    assert.equal(callCount, 3); // initial + 2 retries
});

test("GeminiEmbeddingProvider: retries transient 500 error and succeeds on recovery", async () => {
    let callCount = 0;
    const provider = new GeminiEmbeddingProvider({
        apiKey: "key",
        maxRetries: 2,
        fetch: async () => {
            callCount++;
            if (callCount === 1) {
                return new Response("Internal Server Error", { status: 500 });
            }
            return new Response(
                JSON.stringify({
                    embeddings: [{ values: create768Vector(42) }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    const res = await provider.embed(["test"]);
    assert.equal(callCount, 2);
    assert.equal(res.length, 1);
    assert.deepEqual(res[0], create768Vector(42));
});

test("GeminiEmbeddingProvider: retries transient network failure and succeeds", async () => {
    let callCount = 0;
    const provider = new GeminiEmbeddingProvider({
        apiKey: "key",
        maxRetries: 2,
        fetch: async () => {
            callCount++;
            if (callCount === 1) {
                throw new TypeError("fetch failed");
            }
            return new Response(
                JSON.stringify({
                    embeddings: [{ values: create768Vector(10) }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    const res = await provider.embed(["test"]);
    assert.equal(callCount, 2);
    assert.equal(res.length, 1);
});

test("GeminiEmbeddingProvider: rejects malformed responses and vector inconsistencies", async () => {
    // Missing embeddings array
    const provider1 = new GeminiEmbeddingProvider({
        apiKey: "key",
        maxRetries: 0,
        fetch: async () =>
            new Response(JSON.stringify({}), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
    });
    await assert.rejects(async () => {
        await provider1.embed(["test"]);
    }, /Malformed Gemini embedding response: missing or invalid 'embeddings' array/);

    // Count mismatch
    const provider2 = new GeminiEmbeddingProvider({
        apiKey: "key",
        maxRetries: 0,
        fetch: async () =>
            new Response(
                JSON.stringify({
                    embeddings: [],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            ),
    });
    await assert.rejects(async () => {
        await provider2.embed(["test"]);
    }, /Gemini embedding response count mismatch: expected 1, got 0/);

    // Empty vector
    const provider3 = new GeminiEmbeddingProvider({
        apiKey: "key",
        maxRetries: 0,
        fetch: async () =>
            new Response(
                JSON.stringify({
                    embeddings: [{ values: [] }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            ),
    });
    await assert.rejects(async () => {
        await provider3.embed(["test"]);
    }, /Embedding vector at index 0 is empty/);

    // Dimension mismatch
    const provider4 = new GeminiEmbeddingProvider({
        apiKey: "key",
        dimensions: 768,
        maxRetries: 0,
        fetch: async () =>
            new Response(
                JSON.stringify({
                    embeddings: [{ values: [1, 2, 3] }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            ),
    });
    await assert.rejects(async () => {
        await provider4.embed(["test"]);
    }, /Inconsistent embedding dimensions: expected 768, got 3 at position 0/);

    // Non-finite value
    const provider5 = new GeminiEmbeddingProvider({
        apiKey: "key",
        dimensions: 4,
        maxRetries: 0,
        fetch: async () =>
            new Response(
                JSON.stringify({
                    embeddings: [{ values: [1, NaN, 3, 4] }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            ),
    });
    await assert.rejects(async () => {
        await provider5.embed(["test"]);
    }, /Non-finite value in embedding vector at position 0, dimension 1/);
});

test("GeminiEmbeddingProvider: supports AbortSignal cancellation", async () => {
    const controller = new AbortController();
    const provider = new GeminiEmbeddingProvider({
        apiKey: "key",
        fetch: async (_url, init) => {
            const signal = init?.signal;
            return new Promise((_resolve, reject) => {
                if (signal?.aborted) {
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                    return;
                }
                signal?.addEventListener("abort", () => {
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                });
            });
        },
    });

    const embedPromise = provider.embed(["test"], controller.signal);
    controller.abort();

    await assert.rejects(async () => {
        await embedPromise;
    }, /The operation was aborted/);
});

test("GeminiEmbeddingProvider: immediately rejects if AbortSignal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    let fetchCalled = false;
    const provider = new GeminiEmbeddingProvider({
        apiKey: "key",
        fetch: async () => {
            fetchCalled = true;
            return new Response();
        },
    });

    await assert.rejects(async () => {
        await provider.embed(["test"], controller.signal);
    }, /The operation was aborted/);
    assert.equal(fetchCalled, false);
});

test("GeminiEmbeddingProvider: autoTruncate is included only when explicitly enabled", async () => {
    let capturedBody: any;
    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        autoTruncate: true,
        fetch: async (_url, init) => {
            capturedBody = JSON.parse(init?.body as string);
            return new Response(
                JSON.stringify({
                    embeddings: [{ values: create768Vector(1) }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        },
    });

    await provider.embed(["test explicit autoTruncate"]);
    assert.equal(capturedBody.requests[0].autoTruncate, true);
});

test("GeminiEmbeddingProvider: boundInput output strictly satisfies its token budget across diverse inputs", () => {
    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        maxInputTokens: 2048,
    });

    // 1. CJK characters (1.5 tokens each in estimateTokensForGemini)
    const cjkText =
        "这是一段非常长的中文测试文本，用于测试Gemini嵌入向量输入的截断和词元预算控制。".repeat(
            150,
        );
    const estimatedCjkRaw = estimateTokensForGemini(cjkText);
    assert.ok(estimatedCjkRaw > 2048, "Input must exceed maxInputTokens");
    const boundedCjk = provider.boundInput(cjkText);
    const estimatedCjkBounded = estimateTokensForGemini(boundedCjk);
    assert.ok(
        estimatedCjkBounded <= 2048,
        `Bounded CJK tokens (${estimatedCjkBounded}) must not exceed 2048`,
    );
    assert.ok(boundedCjk.includes("这是一段非常长"));
    assert.ok(boundedCjk.includes("词元预算控制。"));

    // 2. Multi-byte Emoji surrogate pairs
    const emojiText = "🔥🚀🌟⚡🎉💻🔍".repeat(800);
    const estimatedEmojiRaw = estimateTokensForGemini(emojiText);
    assert.ok(estimatedEmojiRaw > 2048, "Emoji input must exceed maxInputTokens");
    const boundedEmoji = provider.boundInput(emojiText);
    const estimatedEmojiBounded = estimateTokensForGemini(boundedEmoji);
    assert.ok(
        estimatedEmojiBounded <= 2048,
        `Bounded Emoji tokens (${estimatedEmojiBounded}) must not exceed 2048`,
    );

    // 3. Code-heavy text with punctuation and indentations
    const codeLines = [];
    for (let i = 0; i < 400; i++) {
        codeLines.push(
            `    const result_${i} = await client.query("SELECT * FROM items WHERE id = ?", [${i}]);`,
        );
    }
    const codeText = codeLines.join("\n");
    const estimatedCodeRaw = estimateTokensForGemini(codeText);
    assert.ok(estimatedCodeRaw > 2048, "Code input must exceed maxInputTokens");
    const boundedCode = provider.boundInput(codeText);
    const estimatedCodeBounded = estimateTokensForGemini(boundedCode);
    assert.ok(
        estimatedCodeBounded <= 2048,
        `Bounded Code tokens (${estimatedCodeBounded}) must not exceed 2048`,
    );

    // 4. Extremely long single string without any whitespace or newlines
    const longSingleString = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(3000); // 108,000 chars
    const estimatedLongRaw = estimateTokensForGemini(longSingleString);
    assert.ok(estimatedLongRaw > 2048, "Long single string must exceed maxInputTokens");
    const boundedLong = provider.boundInput(longSingleString);
    const estimatedLongBounded = estimateTokensForGemini(boundedLong);
    assert.ok(
        estimatedLongBounded <= 2048,
        `Bounded Long string tokens (${estimatedLongBounded}) must not exceed 2048`,
    );
    assert.ok(boundedLong.startsWith("abcdefgh"));
    assert.ok(boundedLong.endsWith("6789"));
});

test("GeminiEmbeddingProvider: enforces overall timeout budget across retries", async () => {
    // Configure overallTimeoutBudgetMs smaller than per-attempt * attempts
    const provider = new GeminiEmbeddingProvider({
        apiKey: "test-key",
        timeoutMs: 300,
        overallTimeoutBudgetMs: 500,
        maxRetries: 3,
        fetch: async (_url, init) => {
            const signal = init?.signal;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    resolve(new Response(JSON.stringify({ embeddings: [] })));
                }, 400);
                signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                });
            });
        },
    });

    await assert.rejects(async () => {
        await provider.embed(["test"]);
    }, /overall timeout budget/);
});
