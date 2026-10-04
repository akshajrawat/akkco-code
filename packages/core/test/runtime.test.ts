import assert from "node:assert";
import test from "node:test";
import { createAkkcoRuntime, type RuntimeEvent, type RuntimeToolHost } from "../src/index.js";
import type { ModelEvent, ModelProvider, ModelRequest, ModelTool } from "@akkco/models";

test("text-only provider response", async () => {
    let callCount = 0;
    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            callCount++;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "Hello world" } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "ok" }),
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    const req: ModelRequest = {
        items: [{ type: "message", role: "user", content: "hi" }],
    };

    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run(req)) {
        events.push(event);
    }

    assert.strictEqual(callCount, 1);
    assert.deepStrictEqual(events, [{ type: "text", content: "Hello world" }]);
});

test("runtime advertises ModelTool[] to provider", async () => {
    const dummyTools: ModelTool[] = [
        {
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
    ];

    let capturedTools: ModelTool[] | undefined;
    const provider: ModelProvider = {
        id: "mock",
        stream: (request) => {
            capturedTools = request.tools;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "done" } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: dummyTools,
        execute: async () => ({ content: "ok" }),
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run({
        items: [{ type: "message", role: "user", content: "test" }],
    })) {
        events.push(event);
    }

    assert.strictEqual(capturedTools, dummyTools);
});

test("model emits one tool call → runtime executes → model called again", async () => {
    let turn = 0;
    let toolExecuted = false;

    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turn++;
            if (turn === 1) {
                return {
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: "tool_call",
                            id: "call_1",
                            name: "calculator",
                            arguments: { a: 2, b: 3 },
                        } satisfies ModelEvent;
                    },
                };
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "The answer is 5." } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [{ name: "calculator", description: "calc", inputSchema: {} }],
        execute: async (name, input: any) => {
            toolExecuted = true;
            assert.strictEqual(name, "calculator");
            return { content: String(input.a + input.b) };
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run({
        items: [{ type: "message", role: "user", content: "2+3" }],
    })) {
        events.push(event);
    }

    assert.strictEqual(turn, 2);
    assert.strictEqual(toolExecuted, true);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, "tool_execution");
    if (events[0].type === "tool_execution") {
        assert.strictEqual(events[0].callId, "call_1");
        assert.strictEqual(events[0].toolName, "calculator");
        assert.strictEqual(events[0].status, "completed");
        assert.strictEqual(events[0].result, "5");
    }
    assert.deepStrictEqual(events[1], { type: "text", content: "The answer is 5." });
});

test("tool result is present in second ModelRequest", async () => {
    let capturedRequests: ModelRequest[] = [];

    const provider: ModelProvider = {
        id: "mock",
        stream: (request) => {
            capturedRequests.push(request);
            if (capturedRequests.length === 1) {
                return {
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: "tool_call",
                            id: "call_abc",
                            name: "get_user",
                            arguments: { id: "u123" },
                        } satisfies ModelEvent;
                    },
                };
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "User is Alice" } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: JSON.stringify({ name: "Alice" }) }),
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    for await (const _event of runtime.run({
        items: [{ type: "message", role: "user", content: "who is u123" }],
    })) {
    }

    assert.strictEqual(capturedRequests.length, 2);
    const secondReq = capturedRequests[1];
    assert.strictEqual(secondReq.items.length, 3);
    assert.deepStrictEqual(secondReq.items[0], {
        type: "message",
        role: "user",
        content: "who is u123",
    });
    assert.deepStrictEqual(secondReq.items[1], {
        type: "tool_call",
        id: "call_abc",
        name: "get_user",
        arguments: { id: "u123" },
    });
    assert.deepStrictEqual(secondReq.items[2], {
        type: "tool_result",
        callId: "call_abc",
        content: JSON.stringify({ name: "Alice" }),
    });
});

test("final assistant text streams after tool result", async () => {
    let turn = 0;
    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turn++;
            if (turn === 1) {
                return {
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: "tool_call",
                            id: "call_order",
                            name: "test_tool",
                            arguments: {},
                        } satisfies ModelEvent;
                    },
                };
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "Final " } satisfies ModelEvent;
                    yield { type: "text", content: "Answer" } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "done" }),
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run({
        items: [{ type: "message", role: "user", content: "go" }],
    })) {
        events.push(event);
    }

    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].type, "tool_execution");
    assert.deepStrictEqual(events[1], { type: "text", content: "Final " });
    assert.deepStrictEqual(events[2], { type: "text", content: "Answer" });
});

test("text before tool call is preserved", async () => {
    let capturedRequests: ModelRequest[] = [];
    const provider: ModelProvider = {
        id: "mock",
        stream: (req) => {
            capturedRequests.push(req);
            if (capturedRequests.length === 1) {
                return {
                    async *[Symbol.asyncIterator]() {
                        yield { type: "text", content: "Let me check that." } satisfies ModelEvent;
                        yield {
                            type: "tool_call",
                            id: "c_lookup",
                            name: "lookup",
                            arguments: { key: "status" },
                        } satisfies ModelEvent;
                    },
                };
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "Status is active." } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "active" }),
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run({
        items: [{ type: "message", role: "user", content: "status?" }],
    })) {
        events.push(event);
    }

    // Verify events sequence
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(events[0], { type: "text", content: "Let me check that." });
    assert.strictEqual(events[1].type, "tool_execution");
    assert.deepStrictEqual(events[2], { type: "text", content: "Status is active." });

    // Verify second request items contain the pre-tool assistant message
    const secondReq = capturedRequests[1];
    assert.deepStrictEqual(secondReq.items[1], {
        type: "message",
        role: "assistant",
        content: "Let me check that.",
    });
    assert.deepStrictEqual(secondReq.items[2], {
        type: "tool_call",
        id: "c_lookup",
        name: "lookup",
        arguments: { key: "status" },
    });
    assert.deepStrictEqual(secondReq.items[3], {
        type: "tool_result",
        callId: "c_lookup",
        content: "active",
    });
});

test("multiple tool calls in one model turn execute sequentially", async () => {
    const executedOrder: string[] = [];
    let turn = 0;

    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turn++;
            if (turn === 1) {
                return {
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: "tool_call",
                            id: "call_1",
                            name: "tool_alpha",
                            arguments: {},
                        } satisfies ModelEvent;
                        yield {
                            type: "tool_call",
                            id: "call_2",
                            name: "tool_beta",
                            arguments: {},
                        } satisfies ModelEvent;
                    },
                };
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "Both done." } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async (name) => {
            executedOrder.push(name);
            return { content: `${name} output` };
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run({
        items: [{ type: "message", role: "user", content: "run both" }],
    })) {
        events.push(event);
    }

    assert.deepStrictEqual(executedOrder, ["tool_alpha", "tool_beta"]);
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].type, "tool_execution");
    if (events[0].type === "tool_execution") {
        assert.strictEqual(events[0].toolName, "tool_alpha");
    }
    assert.strictEqual(events[1].type, "tool_execution");
    if (events[1].type === "tool_execution") {
        assert.strictEqual(events[1].toolName, "tool_beta");
    }
    assert.deepStrictEqual(events[2], { type: "text", content: "Both done." });
});

test("tool execution failure becomes isError tool result and model gets another chance", async () => {
    let capturedRequests: ModelRequest[] = [];

    const provider: ModelProvider = {
        id: "mock",
        stream: (req) => {
            capturedRequests.push(req);
            if (capturedRequests.length === 1) {
                return {
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: "tool_call",
                            id: "c_fail",
                            name: "flaky_tool",
                            arguments: {},
                        } satisfies ModelEvent;
                    },
                };
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "Recovered from failure" } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => {
            throw new Error("Disk read failed");
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run({
        items: [{ type: "message", role: "user", content: "read" }],
    })) {
        events.push(event);
    }

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, "tool_execution");
    if (events[0].type === "tool_execution") {
        assert.strictEqual(events[0].status, "failed");
        assert.strictEqual(events[0].error, "Disk read failed");
    }
    assert.deepStrictEqual(events[1], { type: "text", content: "Recovered from failure" });

    // Verify second request contains isError tool_result
    const secondReq = capturedRequests[1];
    assert.deepStrictEqual(secondReq.items[2], {
        type: "tool_result",
        callId: "c_fail",
        content: "Disk read failed",
        isError: true,
    });
});

test("unknown/hallucinated tool becomes recoverable failed tool result", async () => {
    let turn = 0;
    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turn++;
            if (turn === 1) {
                return {
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: "tool_call",
                            id: "c_hallucinated",
                            name: "hallucinated_tool",
                            arguments: {},
                        } satisfies ModelEvent;
                    },
                };
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: "text",
                        content: "Apologies, tool not found.",
                    } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async (name) => {
            throw new Error(`Unknown tool: ${name}`);
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run({
        items: [{ type: "message", role: "user", content: "hallucinate" }],
    })) {
        events.push(event);
    }

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, "tool_execution");
    if (events[0].type === "tool_execution") {
        assert.strictEqual(events[0].status, "failed");
        assert.strictEqual(events[0].error, "Unknown tool: hallucinated_tool");
    }
    assert.deepStrictEqual(events[1], { type: "text", content: "Apologies, tool not found." });
});

test("cancellation stops additional tools/provider turns", async () => {
    const controller = new AbortController();
    let secondToolExecuted = false;
    let turn2Called = false;

    const provider: ModelProvider = {
        id: "mock",
        stream: (req) => {
            if (req.items.length > 2) {
                turn2Called = true;
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: "tool_call",
                        id: "c1",
                        name: "first_tool",
                        arguments: {},
                    } satisfies ModelEvent;
                    yield {
                        type: "tool_call",
                        id: "c2",
                        name: "second_tool",
                        arguments: {},
                    } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async (name) => {
            if (name === "first_tool") {
                controller.abort();
                return { content: "first done" };
            }
            secondToolExecuted = true;
            return { content: "second done" };
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost);

    await assert.rejects(
        async () => {
            for await (const _event of runtime.run({
                items: [{ type: "message", role: "user", content: "test" }],
                signal: controller.signal,
            })) {
            }
        },
        (err: any) => err.name === "AbortError" || /aborted/i.test(err.message),
    );

    assert.strictEqual(secondToolExecuted, false);
    assert.strictEqual(turn2Called, false);
});

test("maxToolIterations prevents infinite loops", async () => {
    let turns = 0;
    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turns++;
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: "tool_call",
                        id: `call_${turns}`,
                        name: "infinite_tool",
                        arguments: {},
                    } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "repeat" }),
    };

    const runtime = createAkkcoRuntime(provider, toolHost, { maxToolIterations: 3 });

    await assert.rejects(async () => {
        for await (const _event of runtime.run({
            items: [{ type: "message", role: "user", content: "loop" }],
        })) {
        }
    }, /Maximum tool iterations exceeded/);

    // Iterations allowed were 3, on 4th iteration it exceeds limit
    assert.strictEqual(turns, 4);
});

test("normal multi-step workflow with varying arguments proceeds within default limit", async () => {
    let turns = 0;
    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turns++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (turns <= 10) {
                        yield {
                            type: "tool_call",
                            id: `call_${turns}`,
                            name: "multi_step_tool",
                            arguments: { step: turns },
                        } satisfies ModelEvent;
                    } else {
                        yield {
                            type: "text",
                            content: "done after 10 tool iterations",
                        } satisfies ModelEvent;
                    }
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "step result" }),
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run({
        items: [{ type: "message", role: "user", content: "do 10 steps" }],
    })) {
        events.push(event);
    }

    assert.strictEqual(turns, 11);
    const lastEvent = events[events.length - 1];
    assert.strictEqual(lastEvent.type, "text");
    if (lastEvent.type === "text") {
        assert.strictEqual(lastEvent.content, "done after 10 tool iterations");
    }
});

test("runtime without ToolHost still works as existing text chat", async () => {
    let capturedRequest: ModelRequest | undefined;
    const provider: ModelProvider = {
        id: "mock",
        stream: (request) => {
            capturedRequest = request;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "chat response" } satisfies ModelEvent;
                },
            };
        },
    };

    const runtime = createAkkcoRuntime(provider);
    const controller = new AbortController();
    const req: ModelRequest = {
        items: [{ type: "message", role: "user", content: "hello" }],
        signal: controller.signal,
    };

    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run(req)) {
        events.push(event);
    }

    assert.ok(capturedRequest);
    assert.deepStrictEqual(capturedRequest.items, req.items);
    assert.strictEqual(capturedRequest.tools, undefined);
    assert.strictEqual(capturedRequest.signal, controller.signal);
    assert.deepStrictEqual(events, [{ type: "text", content: "chat response" }]);
});
