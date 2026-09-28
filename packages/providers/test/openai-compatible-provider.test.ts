import assert from "node:assert";
import http from "node:http";
import test from "node:test";
import { OpenAICompatibleProvider } from "../src/index.js";
import {
    mapModelItemToOpenAIMessage,
    mapModelRequestToOpenAIPayload,
    mapModelToolsToOpenAITools,
} from "../src/openai-compatible/request-mapper.js";
import type {
    ModelEvent,
    ModelMessage,
    ModelRequest,
    ModelTool,
    ModelToolCall,
    ModelToolResult,
} from "@akkco/models";

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

const collectEvents = async (
    provider: OpenAICompatibleProvider,
    signalOrRequest?: AbortSignal | ModelRequest
) => {
    const request: ModelRequest =
        signalOrRequest instanceof AbortSignal
            ? { items: [{ type: "message", role: "user", content: "hi" }], signal: signalOrRequest }
            : signalOrRequest ?? { items: [{ type: "message", role: "user", content: "hi" }] };

    const events: ModelEvent[] = [];
    for await (const event of provider.stream(request)) {
        events.push(event);
    }
    return events;
};

// ==========================================
// Request Mapping Tests
// ==========================================

test("normal ModelMessage mapping", () => {
    const systemMsg: ModelMessage = { type: "message", role: "system", content: "System instructions" };
    const userMsg: ModelMessage = { type: "message", role: "user", content: "Hello" };
    const assistantMsg: ModelMessage = { type: "message", role: "assistant", content: "Hi there" };

    assert.deepStrictEqual(mapModelItemToOpenAIMessage(systemMsg), {
        role: "system",
        content: "System instructions",
    });
    assert.deepStrictEqual(mapModelItemToOpenAIMessage(userMsg), {
        role: "user",
        content: "Hello",
    });
    assert.deepStrictEqual(mapModelItemToOpenAIMessage(assistantMsg), {
        role: "assistant",
        content: "Hi there",
    });
});

test("ModelTool[] → OpenAI tools payload", () => {
    const tools: ModelTool[] = [
        {
            name: "read_file",
            description: "Read a file",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
            },
        },
    ];

    const openAITools = mapModelToolsToOpenAITools(tools);
    assert.deepStrictEqual(openAITools, [
        {
            type: "function",
            function: {
                name: "read_file",
                description: "Read a file",
                parameters: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                },
            },
        },
    ]);
});

test("ModelToolCall → assistant tool_calls message", () => {
    const toolCall: ModelToolCall = {
        type: "tool_call",
        id: "call_abc123",
        name: "search_text",
        arguments: { query: "export", path: "src" },
    };

    const mapped = mapModelItemToOpenAIMessage(toolCall);
    assert.deepStrictEqual(mapped, {
        role: "assistant",
        content: null,
        tool_calls: [
            {
                id: "call_abc123",
                type: "function",
                function: {
                    name: "search_text",
                    arguments: JSON.stringify({ query: "export", path: "src" }),
                },
            },
        ],
    });
});

test("ModelToolCall arguments serialization handles string primitive, number, boolean, and null arguments consistently", () => {
    const stringCall: ModelToolCall = {
        type: "tool_call",
        id: "call_str",
        name: "echo_string",
        arguments: "hello world",
    };
    const mappedStr = mapModelItemToOpenAIMessage(stringCall);
    assert.strictEqual(
        (mappedStr as any).tool_calls[0].function.arguments,
        JSON.stringify("hello world")
    );

    const numberCall: ModelToolCall = {
        type: "tool_call",
        id: "call_num",
        name: "calc",
        arguments: 42,
    };
    const mappedNum = mapModelItemToOpenAIMessage(numberCall);
    assert.strictEqual(
        (mappedNum as any).tool_calls[0].function.arguments,
        JSON.stringify(42)
    );

    const boolCall: ModelToolCall = {
        type: "tool_call",
        id: "call_bool",
        name: "toggle",
        arguments: true,
    };
    const mappedBool = mapModelItemToOpenAIMessage(boolCall);
    assert.strictEqual(
        (mappedBool as any).tool_calls[0].function.arguments,
        JSON.stringify(true)
    );

    const nullCall: ModelToolCall = {
        type: "tool_call",
        id: "call_null",
        name: "empty",
        arguments: null,
    };
    const mappedNull = mapModelItemToOpenAIMessage(nullCall);
    assert.strictEqual(
        (mappedNull as any).tool_calls[0].function.arguments,
        JSON.stringify({})
    );
});

test("ModelToolResult → role: 'tool' message", () => {
    const result: ModelToolResult = {
        type: "tool_result",
        callId: "call_abc123",
        content: "File contents here",
        isError: false,
    };

    const mapped = mapModelItemToOpenAIMessage(result);
    assert.deepStrictEqual(mapped, {
        role: "tool",
        tool_call_id: "call_abc123",
        content: "File contents here",
    });
});

test("tools omitted when absent", () => {
    const requestNoTools: ModelRequest = {
        items: [{ type: "message", role: "user", content: "Hi" }],
    };
    const payloadNoTools = mapModelRequestToOpenAIPayload(requestNoTools, "gpt-4o");
    assert.strictEqual(payloadNoTools.tools, undefined);
    assert.strictEqual("tools" in payloadNoTools, false);

    const requestEmptyTools: ModelRequest = {
        items: [{ type: "message", role: "user", content: "Hi" }],
        tools: [],
    };
    const payloadEmptyTools = mapModelRequestToOpenAIPayload(requestEmptyTools, "gpt-4o");
    assert.strictEqual(payloadEmptyTools.tools, undefined);
    assert.strictEqual("tools" in payloadEmptyTools, false);
});

test("executable implementation details are never serialized", async () => {
    let capturedBody: any;
    await withServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write("data: [DONE]\n\n");
            res.end();
        });
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const toolWithExec: any = {
            name: "test_tool",
            description: "Test description",
            inputSchema: { type: "object", properties: {} },
            execute: async () => ({ content: "exec" }),
            extraInternal: "do-not-leak",
        };
        await collectEvents(provider, {
            items: [
                { type: "message", role: "user", content: "run tool" },
                {
                    type: "tool_call",
                    id: "c1",
                    name: "test_tool",
                    arguments: { val: 1 },
                },
                {
                    type: "tool_result",
                    callId: "c1",
                    content: "done",
                    isError: false,
                },
            ],
            tools: [toolWithExec],
        });

        // Verify tools in payload
        assert.ok(capturedBody.tools);
        assert.strictEqual(capturedBody.tools.length, 1);
        const serializedTool = capturedBody.tools[0];
        assert.deepStrictEqual(Object.keys(serializedTool).sort(), ["function", "type"]);
        assert.deepStrictEqual(Object.keys(serializedTool.function).sort(), ["description", "name", "parameters"]);
        assert.strictEqual("execute" in serializedTool, false);
        assert.strictEqual("extraInternal" in serializedTool, false);

        // Verify messages in payload
        const assistantMsg = capturedBody.messages[1];
        assert.strictEqual(assistantMsg.role, "assistant");
        assert.strictEqual(assistantMsg.content, null);
        assert.strictEqual(assistantMsg.tool_calls.length, 1);
        assert.strictEqual(assistantMsg.tool_calls[0].id, "c1");
        assert.strictEqual(assistantMsg.tool_calls[0].function.name, "test_tool");
        assert.strictEqual(assistantMsg.tool_calls[0].function.arguments, JSON.stringify({ val: 1 }));

        const toolResultMsg = capturedBody.messages[2];
        assert.deepStrictEqual(toolResultMsg, {
            role: "tool",
            tool_call_id: "c1",
            content: "done",
        });
    });
});

// ==========================================
// Streaming Tests
// ==========================================

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

test("complete tool call in one SSE event", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: {
                            name: "read_file",
                            arguments: JSON.stringify({ path: "foo.txt" }),
                        },
                    }],
                },
                finish_reason: "tool_calls",
            }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [
            {
                type: "tool_call",
                id: "call_1",
                name: "read_file",
                arguments: { path: "foo.txt" },
            },
        ]);
    });
});

test("tool call arguments fragmented across multiple SSE events", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "call_frag",
                        function: {
                            name: "search",
                            arguments: '{"que',
                        },
                    }],
                },
            }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        function: {
                            arguments: 'ry":"foo"}',
                        },
                    }],
                },
            }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {},
                finish_reason: "tool_calls",
            }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [
            {
                type: "tool_call",
                id: "call_frag",
                name: "search",
                arguments: { query: "foo" },
            },
        ]);
    });
});

test("tool-call name/id appearing only in initial fragment", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "call_init",
                        type: "function",
                        function: {
                            name: "my_tool",
                            arguments: "",
                        },
                    }],
                },
            }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        function: {
                            arguments: '{"count":',
                        },
                    }],
                },
            }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        function: {
                            arguments: "5}",
                        },
                    }],
                },
                finish_reason: "tool_calls",
            }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [
            {
                type: "tool_call",
                id: "call_init",
                name: "my_tool",
                arguments: { count: 5 },
            },
        ]);
    });
});

test("multiple argument fragments combine in correct order", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "call_multi",
                        function: { name: "combine", arguments: '{"first":' },
                    }],
                },
            }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{ index: 0, function: { arguments: '"alpha", ' } }],
                },
            }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{ index: 0, function: { arguments: '"second":' } }],
                },
            }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{ index: 0, function: { arguments: '"beta"}' } }],
                },
                finish_reason: "tool_calls",
            }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [
            {
                type: "tool_call",
                id: "call_multi",
                name: "combine",
                arguments: { first: "alpha", second: "beta" },
            },
        ]);
    });
});

test("valid JSON arguments become parsed unknown value", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "call_json",
                        function: {
                            name: "types_test",
                            arguments: JSON.stringify({
                                count: 42,
                                enabled: true,
                                tags: ["a", "b"],
                                nested: { flag: false },
                            }),
                        },
                    }],
                },
                finish_reason: "tool_calls",
            }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.strictEqual(events.length, 1);
        const event = events[0];
        assert.strictEqual(event.type, "tool_call");
        assert.strictEqual(typeof event.arguments, "object");
        assert.notStrictEqual(event.arguments, null);
        assert.deepStrictEqual(event.arguments, {
            count: 42,
            enabled: true,
            tags: ["a", "b"],
            nested: { flag: false },
        });
    });
});

test("malformed final arguments throw useful error", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "call_broken",
                        function: {
                            name: "broken_tool",
                            arguments: '{"incomplete": ',
                        },
                    }],
                },
                finish_reason: "tool_calls",
            }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        await assert.rejects(
            async () => {
                await collectEvents(provider);
            },
            (err: Error) =>
                /Failed to parse tool call arguments for "broken_tool"/i.test(err.message)
        );
    });
});

test("text followed by tool call emits text then tool_call", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: { content: "Checking records..." },
            }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "c_query",
                        function: { name: "query_db", arguments: '{"q":"users"}' },
                    }],
                },
                finish_reason: "tool_calls",
            }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.deepStrictEqual(events, [
            { type: "text", content: "Checking records..." },
            {
                type: "tool_call",
                id: "c_query",
                name: "query_db",
                arguments: { q: "users" },
            },
        ]);
    });
});

test("[DONE] does not duplicate a previously emitted call", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "c_once",
                        function: { name: "once_tool", arguments: "{}" },
                    }],
                },
                finish_reason: "tool_calls",
            }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const events = await collectEvents(provider);
        assert.strictEqual(events.length, 1);
        assert.deepStrictEqual(events[0], {
            type: "tool_call",
            id: "c_once",
            name: "once_tool",
            arguments: {},
        });
    });
});

test("cancellation during partial tool call emits no incomplete tool_call", async () => {
    let serverRes: http.ServerResponse | undefined;
    await withServer((_req, res) => {
        serverRes = res;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "call_partial",
                        function: {
                            name: "partial_tool",
                            arguments: '{"data":"half',
                        },
                    }],
                },
            }],
        })}\n\n`);
    }, async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ baseUrl, model: "test-model" });
        const controller = new AbortController();
        const events: ModelEvent[] = [];

        setTimeout(() => {
            controller.abort();
        }, 30);

        await assert.rejects(async () => {
            for await (const event of provider.stream({
                items: [{ type: "message", role: "user", content: "run" }],
                signal: controller.signal,
            })) {
                events.push(event);
            }
        }, (err: any) => err.name === "AbortError" || /aborted/i.test(err.message));

        assert.strictEqual(events.some((e) => e.type === "tool_call"), false);
        serverRes?.end();
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
            for await (const event of provider.stream({ items: [{ type: "message", role: "user", content: "hi" }], signal: controller.signal })) {
                if (event.type === "text") {
                    assert.strictEqual(event.content, "chunk1");
                }
                controller.abort();
            }
        }, (err: any) => err.name === "AbortError" || /aborted/i.test(err.message));
    });
});
