import assert from "node:assert/strict";
import test from "node:test";
import type {
    ModelEvent,
    ModelMessage,
    ModelProfile,
    ModelProvider,
    ModelRequest,
} from "@akkco/models";
import {
    ContextBudgetOverflowError,
    createAkkcoRuntime,
    deriveContextBudget,
    formatMilestoneText,
    type RuntimeEvent,
    type RuntimeToolHost,
} from "../src/index.js";

test("Context reconstruction: The original user goal remains unchanged across multi-tool iterations", async () => {
    let turn = 0;
    const capturedRequests: ModelRequest[] = [];
    const originalGoal = "Find all API route declarations in the project";

    const provider: ModelProvider = {
        id: "mock-goal-check",
        stream: (request) => {
            capturedRequests.push(request);
            turn++;
            if (turn === 1) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_routes_1",
                        name: "list_files",
                        arguments: { path: "routes" },
                    } satisfies ModelEvent;
                })();
            }
            if (turn === 2) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_routes_2",
                        name: "read_file",
                        arguments: { path: "routes/api.ts" },
                    } satisfies ModelEvent;
                })();
            }
            return (async function* () {
                yield { type: "text", content: "All routes identified." } satisfies ModelEvent;
            })();
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async (name) => {
            if (name === "list_files") return { content: "api.ts\nauth.ts" };
            if (name === "read_file")
                return { content: "export const routes = ['/users', '/login'];" };
            return { content: "" };
        },
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        milestones: true,
    });

    for await (const _ of runtime.run({
        items: [{ type: "message", role: "user", content: originalGoal }],
    })) {
    }

    assert.equal(capturedRequests.length, 3);

    // In all 3 requests, the user message MUST be the immutable original goal!
    for (let i = 0; i < capturedRequests.length; i++) {
        const req = capturedRequests[i];
        const rootUserMessage = req.items.find(
            (it): it is ModelMessage =>
                it.type === "message" &&
                it.role === "user" &&
                (it.provenance?.source === undefined || it.provenance.source === "user"),
        );
        assert.ok(rootUserMessage, `Request ${i + 1} must preserve the root user goal`);
        assert.equal(rootUserMessage.content, originalGoal);
    }
});

test("Context reconstruction: Completed milestones appear individually in subsequent model requests", async () => {
    let turn = 0;
    const capturedRequests: ModelRequest[] = [];

    const provider: ModelProvider = {
        id: "mock-milestone-order",
        stream: (request) => {
            capturedRequests.push(request);
            turn++;
            if (turn === 1) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_1",
                        name: "list_files",
                        arguments: { path: "." },
                    } satisfies ModelEvent;
                })();
            }
            if (turn === 2) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_2",
                        name: "search_text",
                        arguments: { query: "export" },
                    } satisfies ModelEvent;
                })();
            }
            return (async function* () {
                yield { type: "text", content: "Done." } satisfies ModelEvent;
            })();
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async (name) => {
            if (name === "list_files") return { content: "index.ts\npackage.json" };
            if (name === "search_text") return { content: "index.ts:1:export const foo = 1;" };
            return { content: "" };
        },
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        milestones: true,
    });

    for await (const _ of runtime.run({
        items: [{ type: "message", role: "user", content: "List and search" }],
    })) {
    }

    assert.equal(capturedRequests.length, 3);

    // Request 1: No milestones yet
    assert.equal(capturedRequests[0].items.length, 1);
    assert.equal((capturedRequests[0].items[0] as any).content, "List and search");

    // Request 2: Exactly Milestone 1 appended
    const req2Items = capturedRequests[1].items;
    assert.equal(req2Items.length, 2);
    assert.equal((req2Items[0] as any).content, "List and search");
    assert.equal(req2Items[1].type, "message");
    assert.equal((req2Items[1] as any).role, "user");
    assert.ok((req2Items[1] as any).content.includes('[Milestone: list_files (call_id: "call_1")'));
    assert.ok((req2Items[1] as any).content.includes("index.ts"));

    // Request 3: Both Milestone 1 and Milestone 2 appended as separate items
    const req3Items = capturedRequests[2].items;
    assert.equal(req3Items.length, 3);
    assert.equal((req3Items[0] as any).content, "List and search");
    assert.ok((req3Items[1] as any).content.includes('[Milestone: list_files (call_id: "call_1")'));
    assert.ok(
        (req3Items[2] as any).content.includes('[Milestone: search_text (call_id: "call_2")'),
    );
});

test("Context reconstruction: Redundant assistant narration and historical raw outputs are not unnecessarily replayed", async () => {
    let turn = 0;
    const capturedRequests: ModelRequest[] = [];

    const provider: ModelProvider = {
        id: "mock-prose-check",
        stream: (request) => {
            capturedRequests.push(request);
            turn++;
            if (turn === 1) {
                return (async function* () {
                    // Assistant emits prose narration before tool call
                    yield {
                        type: "text",
                        content: "I am now inspecting the system.\n\n",
                    } satisfies ModelEvent;
                    yield {
                        type: "tool_call",
                        id: "call_inspect",
                        name: "read_file",
                        arguments: { path: "system.ts" },
                    } satisfies ModelEvent;
                })();
            }
            return (async function* () {
                yield { type: "text", content: "Finished inspection." } satisfies ModelEvent;
            })();
        },
    };

    const rawHugeFile = "const a = 1;\n".repeat(200); // 2800 chars
    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: rawHugeFile }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        milestones: true,
    });

    for await (const _ of runtime.run({
        items: [{ type: "message", role: "user", content: "Check system" }],
    })) {
    }

    assert.equal(capturedRequests.length, 2);
    const req2 = capturedRequests[1];

    // Verify raw 2800 char file content is NOT replayed in req2
    const containsRawDump = req2.items.some((it) => (it as any).content?.includes(rawHugeFile));
    assert.equal(
        containsRawDump,
        false,
        "Raw massive file content must NOT be replayed into model request",
    );

    // Verify assistant narration is NOT replayed as a separate assistant turn
    const hasAssistantNarration = req2.items.some(
        (it) =>
            it.type === "message" &&
            it.role === "assistant" &&
            it.content === "I am now inspecting the system.\n\n",
    );
    assert.equal(
        hasAssistantNarration,
        false,
        "Assistant narration from prior turn must not be endlessly accumulated",
    );
});

test("Context reconstruction: Respects token budget and fails closed when context overflows", async () => {
    const profile: ModelProfile = {
        id: "tiny-profile",
        contextWindowTokens: 100, // Very small window
        maxOutputTokens: 20,
        safetyMarginTokens: 10,
        toolMode: "native",
        charsPerToken: 4,
    };
    const budget = deriveContextBudget(profile);

    const provider: ModelProvider = {
        id: "mock-provider",
        stream: () => {
            return (async function* () {
                yield { type: "text", content: "ok" } satisfies ModelEvent;
            })();
        },
    };

    const runtime = createAkkcoRuntime(provider, {
        profile,
        budget,
        milestones: true,
    });

    // Send a user prompt that alone exceeds the 70 available tokens
    const hugePrompt = "Tell me everything about the repository. ".repeat(30); // ~300 tokens

    await assert.rejects(
        async () => {
            for await (const _ of runtime.run({
                items: [{ type: "message", role: "user", content: hugePrompt }],
            })) {
            }
        },
        (err) => err instanceof ContextBudgetOverflowError,
    );
});
