import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEvent, ModelProvider, ModelRequest } from "@akkco/models";
import { TextToolCompatibilityProvider } from "@akkco/providers";
import {
    AgentLoopError,
    createAkkcoRuntime,
    createAkkcoSession,
    type RuntimeEvent,
    type RuntimeToolHost,
} from "../src/index.js";

test("Compatibility: Native tool calling remains functional and correctly pairs call IDs and milestones", async () => {
    let turn = 0;
    const provider: ModelProvider = {
        id: "mock-native-provider",
        stream: () => {
            turn++;
            if (turn === 1) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_native_42",
                        name: "lookup",
                        arguments: { id: "item_9" },
                    } satisfies ModelEvent;
                })();
            }
            return (async function* () {
                yield { type: "text", content: "Native execution finished." } satisfies ModelEvent;
            })();
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [{ name: "lookup", description: "lookup item", inputSchema: {} }],
        execute: async (name, args: any) => {
            assert.equal(name, "lookup");
            assert.equal(args.id, "item_9");
            return { content: "item_9 found" };
        },
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        milestones: true,
    });

    const session = createAkkcoSession(runtime);
    const events: RuntimeEvent[] = [];
    for await (const ev of session.send("Lookup item 9")) {
        events.push(ev);
    }

    assert.equal(events.length, 2);
    const execEvent = events[0];
    assert.equal(execEvent.type, "tool_execution");
    if (execEvent.type === "tool_execution") {
        assert.equal(execEvent.callId, "call_native_42");
        assert.equal(execEvent.toolName, "lookup");
        assert.equal(execEvent.status, "completed");
        assert.ok(execEvent.milestone);
        assert.equal(execEvent.milestone.callId, "call_native_42");
        assert.equal(execEvent.milestone.executionStatus, "completed");
    }
});

test("Compatibility: Textual compatibility calling with TextToolCompatibilityProvider produces milestones", async () => {
    let turn = 0;
    const innerProvider: ModelProvider = {
        id: "mock-compat-inner",
        stream: () => {
            turn++;
            if (turn === 1) {
                return (async function* () {
                    yield {
                        type: "text",
                        content:
                            'I will search the repository.\n\n<akkco_tool_call>{"name":"search_text","arguments":{"query":"test"}}</akkco_tool_call>',
                    } satisfies ModelEvent;
                })();
            }
            return (async function* () {
                yield {
                    type: "text",
                    content: "Compatibility search complete.",
                } satisfies ModelEvent;
            })();
        },
    };

    const compatProvider = new TextToolCompatibilityProvider(innerProvider);

    const toolHost: RuntimeToolHost = {
        tools: [
            {
                name: "search_text",
                description: "Search text in repo",
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
        ],
        execute: async (name, args: any) => {
            assert.equal(name, "search_text");
            assert.equal(args.query, "test");
            return { content: "src/test.ts:10: const test = true;" };
        },
    };

    const runtime = createAkkcoRuntime(compatProvider, {
        toolHost,
        milestones: true,
    });

    const events: RuntimeEvent[] = [];
    for await (const ev of runtime.run({
        items: [{ type: "message", role: "user", content: "Search for test" }],
    })) {
        events.push(ev);
    }

    assert.equal(events.length, 3);
    assert.equal(events[0].type, "text");
    assert.equal(events[1].type, "tool_execution");
    if (events[1].type === "tool_execution") {
        assert.equal(events[1].toolName, "search_text");
        assert.equal(events[1].status, "completed");
        assert.ok(events[1].milestone);
        assert.equal(events[1].milestone.toolName, "search_text");
        assert.equal(events[1].milestone.executionStatus, "completed");
        assert.ok(events[1].milestone.findings.some((f) => f.includes("src/test.ts")));
    }
    assert.equal(events[2].type, "text");
    assert.equal((events[2] as any).content, "Compatibility search complete.");
});

test("Compatibility: Cancellation (AbortSignal) is respected cleanly during tool execution", async () => {
    const abortController = new AbortController();

    const provider: ModelProvider = {
        id: "mock-provider",
        stream: () => {
            return (async function* () {
                yield {
                    type: "tool_call",
                    id: "call_aborted",
                    name: "slow_tool",
                    arguments: {},
                } satisfies ModelEvent;
            })();
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => {
            abortController.abort();
            return { content: "done" };
        },
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        milestones: true,
    });

    await assert.rejects(
        async () => {
            for await (const _ of runtime.run({
                items: [{ type: "message", role: "user", content: "Run slow tool" }],
                signal: abortController.signal,
            })) {
            }
        },
        (err: any) => err.name === "AbortError",
    );
});

test("Compatibility: Existing loop-reliability safeguards still work and generate failure milestones", async () => {
    const provider: ModelProvider = {
        id: "mock-provider-loop",
        stream: () => {
            return (async function* () {
                // Repeated identical tool call
                yield {
                    type: "tool_call",
                    id: "call_repeat",
                    name: "read_file",
                    arguments: { path: "same.ts" },
                } satisfies ModelEvent;
            })();
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "same content" }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        milestones: true,
        reliabilityOptions: {
            repeatedToolCallLimit: 2,
        },
    });

    const toolEvents: RuntimeEvent[] = [];

    await assert.rejects(
        async () => {
            for await (const ev of runtime.run({
                items: [{ type: "message", role: "user", content: "Loop test" }],
            })) {
                if (ev.type === "tool_execution") {
                    toolEvents.push(ev);
                }
            }
        },
        (err) => err instanceof AgentLoopError && err.reason === "repeated_tool_call",
    );

    // Verify a failed milestone was generated on the warning
    const warningEvent = toolEvents.find(
        (e) => e.type === "tool_execution" && e.status === "failed",
    );
    assert.ok(warningEvent && warningEvent.type === "tool_execution");
    assert.ok(warningEvent.milestone);
    assert.equal(warningEvent.milestone.executionStatus, "failed");
    assert.ok(warningEvent.milestone.summary.includes("Repeated tool call"));
});
