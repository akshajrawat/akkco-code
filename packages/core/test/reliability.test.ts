import type { ModelEvent, ModelProvider, ModelRequest } from "@akkco/models";
import assert from "node:assert";
import test from "node:test";
import {
    AgentLoopError,
    canonicalizeValue,
    createAkkcoRuntime,
    getToolCallSignature,
    type RuntimeEvent,
    type RuntimeToolHost,
} from "../src/index.js";

// Helper to create a runtime event collector
const collectEvents = async (
    runtime: ReturnType<typeof createAkkcoRuntime>,
    request: ModelRequest,
): Promise<RuntimeEvent[]> => {
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run(request)) {
        events.push(event);
    }
    return events;
};

// 1. finite default: default maxToolIterations is 25
test("finite default: runtime limits loop to 25 tool iterations by default", async () => {
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
                        name: "step_tool",
                        arguments: { step: turns },
                    } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "ok" }),
    };

    const runtime = createAkkcoRuntime(provider, toolHost);

    await assert.rejects(
        async () => {
            await collectEvents(runtime, {
                items: [{ type: "message", role: "user", content: "infinite" }],
            });
        },
        (err: unknown) => {
            assert.ok(err instanceof AgentLoopError);
            assert.strictEqual(err.reason, "max_tool_iterations");
            assert.match(err.message, /Maximum tool iterations exceeded/);
            return true;
        },
    );

    // Iterations allowed were 25; on the 26th iteration it terminates
    assert.strictEqual(turns, 26);
});

// 2. explicit override: custom reliability options are honored
test("explicit override: custom maxToolIterations, repeatedToolCallLimit, consecutiveToolErrorLimit", async () => {
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
                        name: "step_tool",
                        arguments: { step: turns },
                    } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "ok" }),
    };

    const runtime = createAkkcoRuntime(provider, toolHost, {
        maxToolIterations: 5,
        repeatedToolCallLimit: 2,
        consecutiveToolErrorLimit: 2,
    });

    await assert.rejects(
        async () => {
            await collectEvents(runtime, {
                items: [{ type: "message", role: "user", content: "run" }],
            });
        },
        (err: unknown) => {
            assert.ok(err instanceof AgentLoopError);
            assert.strictEqual(err.reason, "max_tool_iterations");
            return true;
        },
    );

    assert.strictEqual(turns, 6);
});

// 3. invalid configuration: rejects non-positive or non-finite values
test("invalid configuration: rejects non-positive integers, NaN, or non-finite numbers", () => {
    const dummyProvider: ModelProvider = { id: "mock", stream: () => ({}) as any };

    assert.throws(
        () => createAkkcoRuntime(dummyProvider, undefined, { maxToolIterations: 0 }),
        /Invalid maxToolIterations/,
    );
    assert.throws(
        () => createAkkcoRuntime(dummyProvider, undefined, { maxToolIterations: -1 }),
        /Invalid maxToolIterations/,
    );
    assert.throws(
        () => createAkkcoRuntime(dummyProvider, undefined, { maxToolIterations: 1.5 }),
        /Invalid maxToolIterations/,
    );
    assert.throws(
        () => createAkkcoRuntime(dummyProvider, undefined, { repeatedToolCallLimit: 0 }),
        /Invalid repeatedToolCallLimit/,
    );
    assert.throws(
        () => createAkkcoRuntime(dummyProvider, undefined, { repeatedToolCallLimit: -2 }),
        /Invalid repeatedToolCallLimit/,
    );
    assert.throws(
        () => createAkkcoRuntime(dummyProvider, undefined, { consecutiveToolErrorLimit: 0 }),
        /Invalid consecutiveToolErrorLimit/,
    );
    assert.throws(
        () => createAkkcoRuntime(dummyProvider, undefined, { consecutiveToolErrorLimit: NaN }),
        /Invalid consecutiveToolErrorLimit/,
    );
    assert.throws(
        () => createAkkcoRuntime(dummyProvider, undefined, 5 as any),
        /Invalid reliabilityOptions: must be an options object/,
    );
    assert.throws(
        () => createAkkcoRuntime(dummyProvider, undefined, "invalid" as any),
        /Invalid reliabilityOptions: must be an options object/,
    );
});

// 4. repeated identical calls: emits synthetic warning on threshold without executing tool
test("repeated identical calls: warns upon reaching repetition threshold without executing duplicate", async () => {
    let turns = 0;
    let executionCount = 0;

    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turns++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (turns <= 3) {
                        yield {
                            type: "tool_call",
                            id: `call_${turns}`,
                            name: "read_file",
                            arguments: { path: "data.txt" },
                        } satisfies ModelEvent;
                    } else {
                        yield { type: "text", content: "recovered" } satisfies ModelEvent;
                    }
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => {
            executionCount++;
            return { content: "file content" };
        },
    };

    // repeatedToolCallLimit = 3
    const runtime = createAkkcoRuntime(provider, toolHost, { repeatedToolCallLimit: 3 });
    const events = await collectEvents(runtime, {
        items: [{ type: "message", role: "user", content: "read" }],
    });

    // Calls 1 & 2 executed; call 3 was synthetic warning so toolHost was NOT called a 3rd time
    assert.strictEqual(executionCount, 2);

    const toolEvents = events.filter((e) => e.type === "tool_execution");
    assert.strictEqual(toolEvents.length, 3);
    assert.strictEqual(toolEvents[0].status, "completed");
    assert.strictEqual(toolEvents[1].status, "completed");
    assert.strictEqual(toolEvents[2].status, "failed");
    assert.match(toolEvents[2].error!, /Repeated tool call/);
});

// 5. reordered argument keys: equivalent object arguments detected regardless of key order
test("reordered argument keys: canonicalization detects identical calls despite different key order", async () => {
    let turns = 0;
    let executionCount = 0;

    const argsVariants = [
        { path: "foo.txt", encoding: "utf-8", flag: true },
        { flag: true, path: "foo.txt", encoding: "utf-8" },
        { encoding: "utf-8", flag: true, path: "foo.txt" },
    ];

    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turns++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (turns <= 3) {
                        yield {
                            type: "tool_call",
                            id: `call_${turns}`,
                            name: "fetch",
                            arguments: argsVariants[turns - 1],
                        } satisfies ModelEvent;
                    } else {
                        yield { type: "text", content: "done" } satisfies ModelEvent;
                    }
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => {
            executionCount++;
            return { content: "ok" };
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost, { repeatedToolCallLimit: 3 });
    const events = await collectEvents(runtime, {
        items: [{ type: "message", role: "user", content: "go" }],
    });

    // 3rd call triggered repetition warning despite key ordering differences
    assert.strictEqual(executionCount, 2);
    const lastTool = events.filter((e) => e.type === "tool_execution")[2];
    assert.strictEqual(lastTool.status, "failed");
    assert.match(lastTool.error!, /Repeated tool call/);
});

// 6. same tool with different arguments: does not trigger repetition warning and resets counter
test("same tool with different arguments: different arguments do not trigger repetition warning", async () => {
    let turns = 0;
    let executionCount = 0;

    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turns++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (turns <= 5) {
                        yield {
                            type: "tool_call",
                            id: `call_${turns}`,
                            name: "search_text",
                            arguments: { query: `term_${turns}` },
                        } satisfies ModelEvent;
                    } else {
                        yield { type: "text", content: "search complete" } satisfies ModelEvent;
                    }
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => {
            executionCount++;
            return { content: "match" };
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost, { repeatedToolCallLimit: 3 });
    const events = await collectEvents(runtime, {
        items: [{ type: "message", role: "user", content: "search terms" }],
    });

    assert.strictEqual(executionCount, 5);
    const failedTools = events.filter((e) => e.type === "tool_execution" && e.status === "failed");
    assert.strictEqual(failedTools.length, 0);
});

// 7. recovery after repetition warning: model changes action/args after warning and succeeds
test("recovery after repetition warning: model switches to another tool call and succeeds", async () => {
    let turns = 0;
    const executedTools: string[] = [];

    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turns++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (turns === 1 || turns === 2 || turns === 3) {
                        yield {
                            type: "tool_call",
                            id: `call_${turns}`,
                            name: "read_file",
                            arguments: { path: "bad.txt" },
                        } satisfies ModelEvent;
                    } else if (turns === 4) {
                        // Recovery turn: model switches strategy
                        yield {
                            type: "tool_call",
                            id: `call_${turns}`,
                            name: "list_files",
                            arguments: { path: "." },
                        } satisfies ModelEvent;
                    } else {
                        yield { type: "text", content: "found files" } satisfies ModelEvent;
                    }
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async (name) => {
            executedTools.push(name);
            return { content: "result" };
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost, { repeatedToolCallLimit: 3 });
    const events = await collectEvents(runtime, {
        items: [{ type: "message", role: "user", content: "start" }],
    });

    // read_file executed twice; 3rd call warned; 4th call was list_files
    assert.deepStrictEqual(executedTools, ["read_file", "read_file", "list_files"]);

    const textEvent = events.find((e) => e.type === "text");
    assert.ok(textEvent);
    assert.strictEqual(textEvent.content, "found files");
});

// 8. continued repetition termination: repeating call again after warning terminates loop
test("continued repetition termination: terminates with AgentLoopError(repeated_tool_call)", async () => {
    let turns = 0;

    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turns++;
            return {
                async *[Symbol.asyncIterator]() {
                    // Turn 1, 2, 3: same tool call (3rd reaches warning threshold)
                    // Turn 4: repeats same call without changing strategy
                    yield {
                        type: "tool_call",
                        id: `call_${turns}`,
                        name: "stuck_tool",
                        arguments: { action: "retry" },
                    } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "still stuck" }),
    };

    const runtime = createAkkcoRuntime(provider, toolHost, { repeatedToolCallLimit: 3 });

    await assert.rejects(
        async () => {
            await collectEvents(runtime, {
                items: [{ type: "message", role: "user", content: "start" }],
            });
        },
        (err: unknown) => {
            assert.ok(err instanceof AgentLoopError);
            assert.strictEqual(err.reason, "repeated_tool_call");
            return true;
        },
    );

    // Turn 1, 2: executed; Turn 3: warned; Turn 4: terminated
    assert.strictEqual(turns, 4);
});

// 9. error counter reset after success: successful execution resets consecutive errors
test("error counter reset after success: success resets consecutive failure counter", async () => {
    let turns = 0;
    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turns++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (turns <= 4) {
                        yield {
                            type: "tool_call",
                            id: `call_${turns}`,
                            name: "test_tool",
                            arguments: { turn: turns },
                        } satisfies ModelEvent;
                    } else {
                        yield { type: "text", content: "done" } satisfies ModelEvent;
                    }
                },
            };
        },
    };

    // Pattern: Fail, Fail, Success, Fail -> Max consecutive errors is 2 (limit is 3)
    let callIndex = 0;
    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => {
            callIndex++;
            if (callIndex === 1 || callIndex === 2 || callIndex === 4) {
                throw new Error(`Tool failure at call ${callIndex}`);
            }
            return { content: "success at call 3" };
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost, { consecutiveToolErrorLimit: 3 });
    const events = await collectEvents(runtime, {
        items: [{ type: "message", role: "user", content: "run" }],
    });

    const toolEvents = events.filter((e) => e.type === "tool_execution");
    assert.strictEqual(toolEvents.length, 4);
    assert.strictEqual(toolEvents[0].status, "failed");
    assert.strictEqual(toolEvents[1].status, "failed");
    assert.strictEqual(toolEvents[2].status, "completed");
    assert.strictEqual(toolEvents[3].status, "failed");
});

// 10. consecutive error termination: terminates when threshold is reached
test("consecutive error termination: terminates with AgentLoopError(consecutive_tool_errors)", async () => {
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
                        name: "failing_tool",
                        arguments: { turn: turns },
                    } satisfies ModelEvent;
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => {
            throw new Error("Disk read failure");
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost, { consecutiveToolErrorLimit: 3 });

    await assert.rejects(
        async () => {
            await collectEvents(runtime, {
                items: [{ type: "message", role: "user", content: "failing loop" }],
            });
        },
        (err: unknown) => {
            assert.ok(err instanceof AgentLoopError);
            assert.strictEqual(err.reason, "consecutive_tool_errors");
            assert.match(err.message, /consecutive tool error limit/);
            return true;
        },
    );

    // Failed exactly 3 consecutive times then terminated
    assert.strictEqual(turns, 3);
});

// 11. normal multi-step workflow: coordinates complex sequence without premature termination
test("normal multi-step workflow: multi-step sequence executes sequentially and completes", async () => {
    let turns = 0;
    const steps = [
        { tool: "list_files", args: { path: "src" } },
        { tool: "read_file", args: { path: "src/a.ts" } },
        { tool: "read_file", args: { path: "src/b.ts" } },
        { tool: "search_text", args: { query: "export" } },
    ];

    const provider: ModelProvider = {
        id: "mock",
        stream: () => {
            turns++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (turns <= steps.length) {
                        const step = steps[turns - 1];
                        yield {
                            type: "tool_call",
                            id: `call_${turns}`,
                            name: step.tool,
                            arguments: step.args,
                        } satisfies ModelEvent;
                    } else {
                        yield { type: "text", content: "Analysis complete" } satisfies ModelEvent;
                    }
                },
            };
        },
    };

    const executedTools: string[] = [];
    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async (name) => {
            executedTools.push(name);
            return { content: `result of ${name}` };
        },
    };

    const runtime = createAkkcoRuntime(provider, toolHost);
    const events = await collectEvents(runtime, {
        items: [{ type: "message", role: "user", content: "analyze" }],
    });

    assert.deepStrictEqual(executedTools, ["list_files", "read_file", "read_file", "search_text"]);
    const textEvent = events.find((e) => e.type === "text");
    assert.ok(textEvent);
    assert.strictEqual(textEvent.content, "Analysis complete");
});

// 12. cancellation priority: AbortSignal takes precedence over reliability errors
test("cancellation priority: abort signal takes precedence over error limits", async () => {
    const controller = new AbortController();

    const provider: ModelProvider = {
        id: "mock",
        stream: () => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: "tool_call",
                    id: "call_1",
                    name: "failing_tool",
                    arguments: {},
                } satisfies ModelEvent;
            },
        }),
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => {
            controller.abort();
            throw new Error("Tool failed");
        },
    };

    // consecutiveToolErrorLimit: 1 so failure would trigger error limit if not aborted
    const runtime = createAkkcoRuntime(provider, toolHost, { consecutiveToolErrorLimit: 1 });

    await assert.rejects(
        async () => {
            await collectEvents(runtime, {
                items: [{ type: "message", role: "user", content: "test" }],
                signal: controller.signal,
            });
        },
        (err: any) => {
            assert.notStrictEqual(err.name, "AgentLoopError");
            assert.ok(err.name === "AbortError" || /aborted/i.test(err.message));
            return true;
        },
    );
});

// Canonicalization unit tests
test("canonicalizeValue and getToolCallSignature: deterministic argument canonicalization", () => {
    const sig1 = getToolCallSignature("tool", { a: 1, b: 2, c: { y: 2, x: 1 } });
    const sig2 = getToolCallSignature("tool", { c: { x: 1, y: 2 }, b: 2, a: 1 });
    assert.strictEqual(sig1, sig2);

    assert.strictEqual(getToolCallSignature("tool", undefined), getToolCallSignature("tool", {}));
    assert.strictEqual(getToolCallSignature("tool", null), getToolCallSignature("tool", {}));

    const arrVal1 = canonicalizeValue([{ b: 1, a: 2 }]);
    const arrVal2 = canonicalizeValue([{ a: 2, b: 1 }]);
    assert.deepStrictEqual(arrVal1, arrVal2);
});
