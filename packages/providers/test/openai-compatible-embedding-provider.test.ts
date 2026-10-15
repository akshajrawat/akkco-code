import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleEmbeddingProvider } from "../src/index.js";

test("OpenAICompatibleEmbeddingProvider: returns empty array for empty inputs without calling fetch", async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response();
    };

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "text-embedding-3-small",
        });

        const res = await provider.embed([]);
        assert.deepEqual(res, []);
        assert.equal(fetchCalled, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("OpenAICompatibleEmbeddingProvider: batched input preserves ordering even when response data is unordered", async () => {
    const originalFetch = globalThis.fetch;
    let sentBody: any;
    let sentHeaders: any;

    globalThis.fetch = async (_url, options) => {
        sentBody = JSON.parse(options?.body as string);
        sentHeaders = options?.headers;

        // Return data out of order by index
        return new Response(
            JSON.stringify({
                object: "list",
                data: [
                    { index: 1, embedding: [0.2, 0.3, 0.4] },
                    { index: 0, embedding: [0.1, 0.2, 0.3] },
                ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
        );
    };

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1/",
            model: "text-embedding-3-small",
            apiKey: "test-key",
        });

        const inputs = ["first input", "second input"];
        const results = await provider.embed(inputs);

        assert.equal(results.length, 2);
        assert.deepEqual(results[0], [0.1, 0.2, 0.3]);
        assert.deepEqual(results[1], [0.2, 0.3, 0.4]);

        assert.deepEqual(sentBody, {
            model: "text-embedding-3-small",
            input: ["first input", "second input"],
        });
        assert.equal(sentHeaders["Authorization"], "Bearer test-key");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("OpenAICompatibleEmbeddingProvider: handles HTTP error with status and text", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        return new Response("Model not found", { status: 404 });
    };

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "unknown-model",
        });

        await assert.rejects(
            async () => {
                await provider.embed(["test"]);
            },
            {
                name: "Error",
                message: /failed with status 404: Model not found/,
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("OpenAICompatibleEmbeddingProvider: rejects malformed response structure", async () => {
    const originalFetch = globalThis.fetch;

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "test-model",
        });

        // Missing data
        globalThis.fetch = async () => new Response(JSON.stringify({}));
        await assert.rejects(
            async () => {
                await provider.embed(["test"]);
            },
            { message: /missing or invalid 'data' array/ },
        );

        // Count mismatch
        globalThis.fetch = async () =>
            new Response(
                JSON.stringify({
                    data: [{ index: 0, embedding: [1, 2] }],
                }),
            );
        await assert.rejects(
            async () => {
                await provider.embed(["test 1", "test 2"]);
            },
            { message: /response count mismatch/ },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("OpenAICompatibleEmbeddingProvider: rejects non-finite vectors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                data: [{ index: 0, embedding: [1.0, NaN, 3.0] }],
            }),
        );

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "test-model",
        });

        await assert.rejects(
            async () => {
                await provider.embed(["test"]);
            },
            { message: /Non-finite value in embedding vector/ },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("OpenAICompatibleEmbeddingProvider: rejects inconsistent dimensions across items", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                data: [
                    { index: 0, embedding: [1.0, 2.0] },
                    { index: 1, embedding: [1.0, 2.0, 3.0] },
                ],
            }),
        );

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "test-model",
        });

        await assert.rejects(
            async () => {
                await provider.embed(["test 1", "test 2"]);
            },
            { message: /Inconsistent embedding dimensions/ },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("OpenAICompatibleEmbeddingProvider: supports AbortSignal cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new OpenAICompatibleEmbeddingProvider({
        baseUrl: "http://localhost:11434/v1",
        model: "test-model",
    });

    await assert.rejects(
        async () => {
            await provider.embed(["test"], controller.signal);
        },
        { name: "AbortError" },
    );
});

test("F-013: OpenAICompatibleEmbeddingProvider: rejects duplicate indices", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                data: [
                    { index: 0, embedding: [1, 2] },
                    { index: 0, embedding: [3, 4] },
                ],
            }),
        );

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "test-model",
        });

        await assert.rejects(
            async () => {
                await provider.embed(["test 1", "test 2"]);
            },
            { message: /duplicate index/i },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("F-013: OpenAICompatibleEmbeddingProvider: rejects missing indices", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                data: [
                    { index: 0, embedding: [1, 2] },
                    // index 1 missing, index 2 instead with 2 inputs -> index 2 is out of range or missing
                    { index: 2, embedding: [3, 4] },
                ],
            }),
        );

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "test-model",
        });

        await assert.rejects(
            async () => {
                await provider.embed(["test 1", "test 2"]);
            },
            { message: /out-of-range index|Missing embedding vector/i },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("F-013: OpenAICompatibleEmbeddingProvider: rejects negative indices", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                data: [{ index: -1, embedding: [1, 2] }],
            }),
        );

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "test-model",
        });

        await assert.rejects(
            async () => {
                await provider.embed(["test 1"]);
            },
            { message: /out-of-range index/i },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("F-013: OpenAICompatibleEmbeddingProvider: rejects out-of-range indices", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                data: [{ index: 5, embedding: [1, 2] }],
            }),
        );

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "test-model",
        });

        await assert.rejects(
            async () => {
                await provider.embed(["test 1"]);
            },
            { message: /out-of-range index/i },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("F-013: OpenAICompatibleEmbeddingProvider: rejects fractional indices", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                data: [{ index: 0.5, embedding: [1, 2] }],
            }),
        );

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "test-model",
        });

        await assert.rejects(
            async () => {
                await provider.embed(["test 1"]);
            },
            { message: /index must be an integer/i },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("F-013: OpenAICompatibleEmbeddingProvider: correctly maps reordered valid responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                data: [
                    { index: 2, embedding: [0.3, 0.3] },
                    { index: 0, embedding: [0.1, 0.1] },
                    { index: 1, embedding: [0.2, 0.2] },
                ],
            }),
        );

    try {
        const provider = new OpenAICompatibleEmbeddingProvider({
            baseUrl: "http://localhost:11434/v1",
            model: "test-model",
        });

        const vectors = await provider.embed(["input 0", "input 1", "input 2"]);
        assert.deepStrictEqual(vectors, [
            [0.1, 0.1],
            [0.2, 0.2],
            [0.3, 0.3],
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
