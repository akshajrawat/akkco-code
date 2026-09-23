import assert from "node:assert";
import http from "node:http";
import test from "node:test";
import { OpenAICompatibleProvider } from "../src/index.js";
import type { ModelEvent } from "@akkco/models";

const withServer = async (
    handler: http.RequestListener,
    fn: (baseUrl: string) => Promise<void>
) => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    try {
        await fn(baseUrl);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
};

const collectEvents = async (provider: OpenAICompatibleProvider, signal?: AbortSignal) => {
    const events: ModelEvent[] = [];
    for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }], signal })) {
        events.push(event);
    }
    return events;
};

test("Normal SSE streaming yields text chunks", async () => {
    await withServer((req, res) => {
        assert.strictEqual(req.url, "/v1/chat/completions");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "world!" } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [
            { type: "text", content: "Hello " },
            { type: "text", content: "world!" },
        ]);
    });
});

test("Multiple SSE lines in one network chunk", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunk =
            `data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: { content: "B" } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: { content: "C" } }] })}\n\n`;
        res.write(chunk);
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [
            { type: "text", content: "A" },
            { type: "text", content: "B" },
            { type: "text", content: "C" },
        ]);
    });
});

test("One SSE line split across multiple chunks", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "split content" } }] })}\n\n`;
        const mid = Math.floor(line.length / 2);
        res.write(line.slice(0, mid));
        setTimeout(() => {
            res.write(line.slice(mid));
            res.end();
        }, 10);
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [{ type: "text", content: "split content" }]);
    });
});

test("UTF-8 character split across network chunks", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // '🚀' is a 4-byte UTF-8 character: 0xf0 0x9f 0x9a 0x80
        const jsonLine = `data: ${JSON.stringify({ choices: [{ delta: { content: "rocket 🚀 launch" } }] })}\n\n`;
        const buffer = Buffer.from(jsonLine, "utf-8");
        const rocketIndex = buffer.indexOf(Buffer.from("🚀", "utf-8"));
        // Split right in the middle of the 4 bytes of 🚀
        const splitPoint = rocketIndex + 2;
        res.write(buffer.subarray(0, splitPoint));
        setTimeout(() => {
            res.write(buffer.subarray(splitPoint));
            res.end();
        }, 10);
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [{ type: "text", content: "rocket 🚀 launch" }]);
    });
});

test("Handles CRLF formatted lines", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "line1" } }] })}\r\n\r\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "line2" } }] })}\r\n\r\n`);
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [
            { type: "text", content: "line1" },
            { type: "text", content: "line2" },
        ]);
    });
});

test("Stops streaming immediately upon receiving [DONE]", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "before" } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "after" } }] })}\n\n`);
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [{ type: "text", content: "before" }]);
    });
});

test("Ignores empty deltas and non-data lines", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": keep-alive comment\n\n");
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "valid" } }] })}\n\n`);
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [{ type: "text", content: "valid" }]);
    });
});

test("Skips malformed JSON gracefully", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: this is not json\n\n");
        res.write("data: {incomplete json\n\n");
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "recovered" } }] })}\n\n`);
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [{ type: "text", content: "recovered" }]);
    });
});

test("Throws on streamed JSON error message", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ error: { message: "Model is currently overloaded" } })}\n\n`);
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        await assert.rejects(async () => {
            await collectEvents(provider);
        }, /Model is currently overloaded/);
    });
});

test("Throws on non-2xx HTTP response with response body text", async () => {
    await withServer((_req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid API key" }));
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        await assert.rejects(async () => {
            await collectEvents(provider);
        }, /OpenAI request failed with status 401: {"error":"Invalid API key"}/);
    });
});

test("Cancels generation via AbortSignal", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "chunk1" } }] })}\n\n`);
        // Intentionally do not end stream to simulate slow generation
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const controller = new AbortController();

        await assert.rejects(async () => {
            for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }], signal: controller.signal })) {
                assert.strictEqual(event.content, "chunk1");
                controller.abort();
            }
        }, (err: any) => err.name === "AbortError" || /aborted/i.test(err.message));
    });
});
