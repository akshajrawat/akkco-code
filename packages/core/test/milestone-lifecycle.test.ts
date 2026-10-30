import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEvent, ModelProvider, ModelRequest } from "@akkco/models";
import {
    createAkkcoRuntime,
    createMilestoneProcessor,
    type RuntimeEvent,
    type RuntimeToolHost,
    type ToolMilestone,
} from "../src/index.js";

const makeProvider = (
    responses: Array<() => AsyncGenerator<ModelEvent, void, unknown>>,
): ModelProvider => {
    let callIndex = 0;
    return {
        id: "mock-provider",
        stream: () => {
            const responseFn =
                responses[callIndex++] ??
                async function* () {
                    yield { type: "text", content: "Default final answer." } satisfies ModelEvent;
                };
            return responseFn();
        },
    };
};

test("Milestone lifecycle: One completed tool execution creates one completed milestone", async () => {
    const provider = makeProvider([
        async function* () {
            yield {
                type: "tool_call",
                id: "call_001",
                name: "read_file",
                arguments: { path: "src/main.ts" },
            } satisfies ModelEvent;
        },
        async function* () {
            yield { type: "text", content: "File read successfully." } satisfies ModelEvent;
        },
    ]);

    const toolHost: RuntimeToolHost = {
        tools: [{ name: "read_file", description: "Read a file", inputSchema: {} }],
        execute: async (name, args) => {
            assert.equal(name, "read_file");
            return { content: "export const app = 'akkco';" };
        },
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
    });

    const events: RuntimeEvent[] = [];
    for await (const ev of runtime.run({
        items: [{ type: "message", role: "user", content: "Read main.ts" }],
    })) {
        events.push(ev);
    }

    assert.equal(events.length, 2);
    const toolEvent = events[0];
    assert.equal(toolEvent.type, "tool_execution");
    if (toolEvent.type === "tool_execution") {
        assert.equal(toolEvent.callId, "call_001");
        assert.equal(toolEvent.toolName, "read_file");
        assert.equal(toolEvent.status, "completed");
        assert.equal(toolEvent.result, "export const app = 'akkco';");

        // Verify milestone was generated and populated
        const milestone = toolEvent.milestone;
        assert.ok(milestone, "Milestone must be attached to tool execution event");
        assert.equal(milestone.id, "milestone-call_001");
        assert.equal(milestone.callId, "call_001");
        assert.equal(milestone.toolName, "read_file");
        assert.equal(milestone.executionStatus, "completed");
        assert.equal(milestone.processingStatus, "completed");
        assert.ok(milestone.summary.includes("src/main.ts"));
        assert.deepEqual(milestone.sourceLocations, ["src/main.ts"]);
        assert.deepEqual(milestone.evidenceRefs, ["call:call_001"]);
        assert.ok(milestone.estimatedTokens > 0);
    }
});

test("Milestone lifecycle: Multiple sequential tool calls produce separate milestones", async () => {
    let turn = 0;
    const provider: ModelProvider = {
        id: "mock-multi-turn",
        stream: () => {
            turn++;
            if (turn === 1) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_step1",
                        name: "list_files",
                        arguments: { path: "packages" },
                    } satisfies ModelEvent;
                })();
            }
            if (turn === 2) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_step2",
                        name: "search_text",
                        arguments: { query: "AkkcoRuntime", path: "packages/core" },
                    } satisfies ModelEvent;
                })();
            }
            return (async function* () {
                yield { type: "text", content: "Investigation complete." } satisfies ModelEvent;
            })();
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async (name) => {
            if (name === "list_files") {
                return { content: "core\nmodels\nproviders\nretrieval\ntools" };
            }
            if (name === "search_text") {
                return {
                    content:
                        "packages/core/src/runtime/runtime.ts:53:export const createAkkcoRuntime",
                };
            }
            return { content: "ok" };
        },
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
    });

    const milestones: ToolMilestone[] = [];
    for await (const ev of runtime.run({
        items: [{ type: "message", role: "user", content: "Find AkkcoRuntime implementation" }],
    })) {
        if (ev.type === "tool_execution" && ev.milestone) {
            milestones.push(ev.milestone);
        }
    }

    assert.equal(milestones.length, 2);

    // Milestone 1 assertions
    assert.equal(milestones[0].id, "milestone-call_step1");
    assert.equal(milestones[0].callId, "call_step1");
    assert.equal(milestones[0].toolName, "list_files");
    assert.equal(milestones[0].executionStatus, "completed");
    assert.equal(milestones[0].processingStatus, "completed");
    assert.ok(milestones[0].summary.includes("packages"));
    assert.ok(milestones[0].findings.includes("core"));

    // Milestone 2 assertions
    assert.equal(milestones[1].id, "milestone-call_step2");
    assert.equal(milestones[1].callId, "call_step2");
    assert.equal(milestones[1].toolName, "search_text");
    assert.equal(milestones[1].executionStatus, "completed");
    assert.equal(milestones[1].processingStatus, "completed");
    assert.ok(milestones[1].summary.includes("AkkcoRuntime"));
    assert.ok(milestones[1].sourceLocations?.some((loc) => loc.includes("runtime.ts")));
});

test("Milestone lifecycle: Multiple calls in one response preserve independent results", async () => {
    const provider = makeProvider([
        async function* () {
            // Emits 2 tool calls in parallel within one turn
            yield {
                type: "tool_call",
                id: "parallel_1",
                name: "read_file",
                arguments: { path: "file_a.txt" },
            } satisfies ModelEvent;
            yield {
                type: "tool_call",
                id: "parallel_2",
                name: "read_file",
                arguments: { path: "file_b.txt" },
            } satisfies ModelEvent;
        },
        async function* () {
            yield { type: "text", content: "Both files inspected." } satisfies ModelEvent;
        },
    ]);

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async (_name, args: any) => {
            if (args.path === "file_a.txt") return { content: "Alpha content" };
            if (args.path === "file_b.txt") return { content: "Beta content" };
            return { content: "" };
        },
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
    });

    const milestones: ToolMilestone[] = [];
    for await (const ev of runtime.run({
        items: [{ type: "message", role: "user", content: "Read file A and B" }],
    })) {
        if (ev.type === "tool_execution" && ev.milestone) {
            milestones.push(ev.milestone);
        }
    }

    assert.equal(milestones.length, 2);
    assert.equal(milestones[0].callId, "parallel_1");
    assert.deepEqual(milestones[0].sourceLocations, ["file_a.txt"]);
    assert.ok(milestones[0].findings[0].includes("Alpha content"));

    assert.equal(milestones[1].callId, "parallel_2");
    assert.deepEqual(milestones[1].sourceLocations, ["file_b.txt"]);
    assert.ok(milestones[1].findings[0].includes("Beta content"));
});

test("Milestone lifecycle: Failed and cancelled calls are not represented as successful findings", async () => {
    const provider = makeProvider([
        async function* () {
            yield {
                type: "tool_call",
                id: "call_fail",
                name: "read_file",
                arguments: { path: "nonexistent.ts" },
            } satisfies ModelEvent;
        },
        async function* () {
            yield { type: "text", content: "Noticed the error." } satisfies ModelEvent;
        },
    ]);

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => {
            throw new Error("ENOENT: no such file or directory, open 'nonexistent.ts'");
        },
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
    });

    const toolEvents: RuntimeEvent[] = [];
    for await (const ev of runtime.run({
        items: [{ type: "message", role: "user", content: "Read missing file" }],
    })) {
        if (ev.type === "tool_execution") {
            toolEvents.push(ev);
        }
    }

    assert.equal(toolEvents.length, 1);
    const event = toolEvents[0];
    if (event.type === "tool_execution") {
        assert.equal(event.status, "failed");
        assert.ok(event.error?.includes("ENOENT"));

        const milestone = event.milestone;
        assert.ok(milestone);
        assert.equal(milestone.executionStatus, "failed");
        assert.equal(milestone.processingStatus, "completed");
        assert.ok(milestone.summary.includes("failed"));
        assert.deepEqual(milestone.findings, []); // Must NOT have successful findings
        assert.ok(milestone.unresolvedQuestions && milestone.unresolvedQuestions.length > 0);
        assert.ok(milestone.unresolvedQuestions[0].includes("ENOENT"));
    }
});
