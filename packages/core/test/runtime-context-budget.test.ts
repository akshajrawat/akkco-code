import assert from "node:assert/strict";
import test from "node:test";
import type {
    ModelEvent,
    ModelItem,
    ModelProfile,
    ModelProvider,
    ModelRequest,
    ModelTool,
} from "@akkco/models";
import {
    ContextBudgetOverflowError,
    createAkkcoRuntime,
    createContextCompactor,
    estimateTokens,
    type ContextBudget,
    type ContextCompactor,
    type RuntimeEvent,
    type RuntimeToolHost,
} from "../src/index.js";
import { createTextToolCompatibilityProvider } from "@akkco/providers";

// Helper to create a fake streaming provider that records requests
const createCaptureProvider = (
    capturedRequests: ModelRequest[],
    responder: (req: ModelRequest, callIndex: number) => AsyncIterable<ModelEvent>,
): ModelProvider => {
    let callIndex = 0;
    return {
        id: "capture-mock-provider",
        stream: (request: ModelRequest) => {
            capturedRequests.push({
                items: request.items.map((it) => ({ ...it })),
                tools: request.tools,
                signal: request.signal,
                profile: request.profile,
            });
            const currentCall = callIndex++;
            return responder(request, currentCall);
        },
    };
};

// ============================================================================
// Group A: Sufficient Available Capacity
// ============================================================================

test("Regression A: Full tool results preserved when complete outgoing request fits without compaction", async () => {
    // Requirements:
    // - Effective input capacity: 30,000 tokens
    // - Existing request: ~5,000 tokens
    // - Tool result: ~8,000 tokens
    // Verify:
    // - No AI compaction call occurs
    // - The full tool result reaches the underlying provider
    // - The request satisfies final preflight
    // - Full canonical output is preserved

    const profile: ModelProfile = {
        id: "test-large-window",
        contextWindowTokens: 32000,
        maxOutputTokens: 1000,
        safetyMarginTokens: 1000,
        toolMode: "native",
        charsPerToken: 4,
    };
    // Derived input capacity: 32000 - 1000 - 1000 = 30,000 tokens

    let compactorInvoked = false;
    const compactor: ContextCompactor = {
        compactHistory: async () => null,
        compactToolResult: async () => {
            compactorInvoked = true;
            return "Compacted output";
        },
    };

    const capturedRequests: ModelRequest[] = [];
    const provider = createCaptureProvider(capturedRequests, async function* (_req, callIdx) {
        if (callIdx === 0) {
            yield {
                type: "tool_call",
                id: "call_a1",
                name: "read_large_file",
                arguments: { path: "data.txt" },
            };
        } else {
            yield {
                type: "text",
                content: "File reading completed successfully.",
            };
        }
    });

    // ~8,000 tokens at charsPerToken: 4 -> ~32,000 characters
    const exactToolContent = "DATA_CHUNK_8000_TOKENS_LINE_".repeat(1100);
    const estimatedToolTokens = estimateTokens(exactToolContent, 4);
    assert.ok(
        estimatedToolTokens >= 7500 && estimatedToolTokens <= 8500,
        `Expected tool result ~8,000 tokens, got ${estimatedToolTokens}`,
    );

    const toolHost: RuntimeToolHost = {
        tools: [
            {
                name: "read_large_file",
                description: "reads large file",
                inputSchema: { type: "object", properties: { path: { type: "string" } } },
            },
        ],
        execute: async () => ({ content: exactToolContent }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        compactor,
        profile,
    });

    // Initial user prompt of ~5,000 tokens -> ~20,000 characters
    const userPromptContent = "USER_PROMPT_CONVERSATION_HISTORY_".repeat(600);
    const estimatedPromptTokens = estimateTokens(userPromptContent, 4);
    assert.ok(
        estimatedPromptTokens >= 4800 && estimatedPromptTokens <= 5500,
        `Expected user prompt ~5,000 tokens, got ${estimatedPromptTokens}`,
    );

    const events: RuntimeEvent[] = [];
    for await (const ev of runtime.run({
        items: [{ type: "message", role: "user", content: userPromptContent }],
        profile,
    })) {
        events.push(ev);
    }

    // 1. Verify no AI compaction call occurred
    assert.strictEqual(
        compactorInvoked,
        false,
        "AI compaction should NOT trigger when complete request fits within input capacity",
    );

    // 2. Verify 2 provider calls were made and request satisfied final preflight
    assert.strictEqual(capturedRequests.length, 2);

    // 3. Verify full tool result reaches the underlying provider
    const secondReq = capturedRequests[1];
    const toolResultItem = secondReq.items.find((it) => it.type === "tool_result");
    assert.ok(toolResultItem, "Second model request must contain tool_result");
    if (toolResultItem.type === "tool_result") {
        assert.strictEqual(
            toolResultItem.content,
            exactToolContent,
            "Provider must receive uncompacted original tool content",
        );
    }

    // 4. Verify runtime event preserves full canonical output
    const toolEvent = events.find((ev) => ev.type === "tool_execution");
    assert.ok(toolEvent, "Must emit tool_execution event");
    if (toolEvent.type === "tool_execution") {
        assert.strictEqual(toolEvent.result, exactToolContent);
        assert.strictEqual(toolEvent.status, "completed");
    }
});

// ============================================================================
// Group B: Insufficient Capacity
// ============================================================================

test("Regression B: Compaction triggers when active tool result exceeds capacity even after history eviction", async () => {
    // Profile with small context: window 1000, output 100, safety 100 -> capacity 800 tokens
    const profile: ModelProfile = {
        id: "test-small-window",
        contextWindowTokens: 1000,
        maxOutputTokens: 100,
        safetyMarginTokens: 100,
        toolMode: "native",
        charsPerToken: 4,
    };

    let compactorInvoked = false;
    let targetTokensReceived = 0;
    const compactor: ContextCompactor = {
        compactHistory: async () => null,
        compactToolResult: async ({ targetTokens, toolName, callId, content }) => {
            compactorInvoked = true;
            targetTokensReceived = targetTokens;
            return `[Summary of ${toolName} (${callId})]: Compacted summary of ${content.length} chars. Details omitted for token budget.`;
        },
    };

    const capturedRequests: ModelRequest[] = [];
    const provider = createCaptureProvider(capturedRequests, async function* (_req, callIdx) {
        if (callIdx === 0) {
            yield {
                type: "tool_call",
                id: "c_insufficient",
                name: "fetch_logs",
                arguments: {},
            };
        } else {
            yield {
                type: "text",
                content: "Processed compacted logs.",
            };
        }
    });

    // Tool output is 6,000 characters = ~1,500 tokens > 800 token capacity!
    const rawToolOutput = "VERBOSE_SERVER_LOG_LINE_WITH_STACK_TRACE_".repeat(150);

    const toolHost: RuntimeToolHost = {
        tools: [
            {
                name: "fetch_logs",
                description: "fetch logs",
                inputSchema: { type: "object" },
            },
        ],
        execute: async () => ({ content: rawToolOutput }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        compactor,
        profile,
    });

    // Request with optional historical turns + active user prompt
    const historyItem1: ModelItem = {
        type: "message",
        role: "user",
        content: "Prior question 1",
    };
    const historyItem2: ModelItem = {
        type: "message",
        role: "assistant",
        content: "Prior response 1",
    };
    const activePrompt: ModelItem = {
        type: "message",
        role: "user",
        content: "Please fetch logs",
    };

    const events: RuntimeEvent[] = [];
    for await (const ev of runtime.run({
        items: [historyItem1, historyItem2, activePrompt],
        profile,
    })) {
        events.push(ev);
    }

    // 1. Verify compaction was triggered
    assert.strictEqual(
        compactorInvoked,
        true,
        "Compaction must trigger when tool result exceeds budget",
    );
    assert.ok(targetTokensReceived > 0 && targetTokensReceived <= 800);

    // 2. Verify resulting second request fits within capacity
    assert.strictEqual(capturedRequests.length, 2);
    const secondReq = capturedRequests[1];
    const toolResultItem = secondReq.items.find((it) => it.type === "tool_result");
    assert.ok(toolResultItem);
    if (toolResultItem.type === "tool_result") {
        assert.ok(toolResultItem.content.includes("[Summary of fetch_logs (c_insufficient)]:"));
        // 3. Tool-call / result continuity preserved
        assert.strictEqual(toolResultItem.callId, "c_insufficient");
    }

    // 4. Original tool output is not modified in runtime event
    const toolEvent = events.find((ev) => ev.type === "tool_execution");
    assert.ok(toolEvent);
    if (toolEvent.type === "tool_execution") {
        assert.strictEqual(toolEvent.result, rawToolOutput);
    }
});

// ============================================================================
// Group C: Explicit Hard Tool Limit
// ============================================================================

test("Regression C: Explicit maxToolOutputTokens hard limit is honored even with large context window", async () => {
    // Model with huge window: 100,000 tokens
    const profile: ModelProfile = {
        id: "test-huge-window",
        contextWindowTokens: 100000,
        maxOutputTokens: 2000,
        safetyMarginTokens: 1000,
        toolMode: "native",
        charsPerToken: 4,
    };

    let compactorInvoked = false;
    let targetTokensReceived = 0;
    const compactor: ContextCompactor = {
        compactHistory: async () => null,
        compactToolResult: async ({ targetTokens, toolName, callId }) => {
            compactorInvoked = true;
            targetTokensReceived = targetTokens;
            return `[Summary of ${toolName} (${callId})]: Compacted within limit.`;
        },
    };

    const capturedRequests: ModelRequest[] = [];
    const provider = createCaptureProvider(capturedRequests, async function* (_req, callIdx) {
        if (callIdx === 0) {
            yield {
                type: "tool_call",
                id: "c_hard_limit",
                name: "query_database",
                arguments: {},
            };
        } else {
            yield {
                type: "text",
                content: "Query analyzed.",
            };
        }
    });

    // Tool returns 4,000 characters = ~1,000 tokens. Fits in 97,000 window, but maxToolOutputTokens is 200!
    const rawResult = "ROW_DATA_RECORD_FIELD_VALUE_".repeat(140);

    const toolHost: RuntimeToolHost = {
        tools: [
            {
                name: "query_database",
                description: "query db",
                inputSchema: { type: "object" },
            },
        ],
        execute: async () => ({ content: rawResult }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        compactor,
        profile,
        maxToolOutputTokens: 200,
    });

    for await (const _ of runtime.run({
        items: [{ type: "message", role: "user", content: "Run query" }],
        profile,
    })) {
    }

    // Must trigger compaction because tool output exceeds maxToolOutputTokens (200)
    assert.strictEqual(compactorInvoked, true);
    assert.strictEqual(
        targetTokensReceived,
        200,
        "Compaction target must equal explicit hard limit",
    );

    // Second request received compacted content
    assert.strictEqual(capturedRequests.length, 2);
    const secondReq = capturedRequests[1];
    const toolResult = secondReq.items.find((it) => it.type === "tool_result");
    assert.ok(toolResult);
    if (toolResult.type === "tool_result") {
        assert.ok(toolResult.content.includes("Compacted within limit"));
    }
});

// ============================================================================
// Group D: Effective ModelProfile Precedence
// ============================================================================

test("Regression D1: Runtime profile only is used consistently", async () => {
    const runtimeProfile: ModelProfile = {
        id: "runtime-only-profile",
        contextWindowTokens: 8000,
        maxOutputTokens: 1000,
        safetyMarginTokens: 500,
        toolMode: "native",
        charsPerToken: 4,
    };

    const capturedRequests: ModelRequest[] = [];
    const provider = createCaptureProvider(capturedRequests, async function* () {
        yield { type: "text", content: "Done" };
    });

    const runtime = createAkkcoRuntime(provider, { profile: runtimeProfile });

    for await (const _ of runtime.run({
        items: [{ type: "message", role: "user", content: "Hello" }],
        // No request.profile
    })) {
    }

    assert.strictEqual(capturedRequests.length, 1);
    assert.strictEqual(capturedRequests[0].profile, runtimeProfile);
});

test("Regression D2: Request profile only overrides absent runtime profile", async () => {
    const requestProfile: ModelProfile = {
        id: "request-only-profile",
        contextWindowTokens: 5000,
        maxOutputTokens: 500,
        safetyMarginTokens: 500,
        toolMode: "native",
        charsPerToken: 4,
    };

    const capturedRequests: ModelRequest[] = [];
    const provider = createCaptureProvider(capturedRequests, async function* () {
        yield { type: "text", content: "Done" };
    });

    const runtime = createAkkcoRuntime(provider); // No profile in constructor

    for await (const _ of runtime.run({
        items: [{ type: "message", role: "user", content: "Hello" }],
        profile: requestProfile,
    })) {
    }

    assert.strictEqual(capturedRequests.length, 1);
    assert.strictEqual(capturedRequests[0].profile, requestProfile);
});

test("Regression D3: Request profile overrides Runtime profile when capacities differ", async () => {
    // Runtime profile has huge capacity (20,000)
    const runtimeProfile: ModelProfile = {
        id: "runtime-huge-profile",
        contextWindowTokens: 22000,
        maxOutputTokens: 1000,
        safetyMarginTokens: 1000,
        toolMode: "native",
        charsPerToken: 4,
    };

    // Request profile has tight capacity (1,200 tokens)
    const requestProfile: ModelProfile = {
        id: "request-tight-profile",
        contextWindowTokens: 1400,
        maxOutputTokens: 100,
        safetyMarginTokens: 100,
        toolMode: "native",
        charsPerToken: 4,
    };

    let compactorInvoked = false;
    let targetTokensReceived = 0;
    const compactor: ContextCompactor = {
        compactHistory: async () => null,
        compactToolResult: async ({ targetTokens }) => {
            compactorInvoked = true;
            targetTokensReceived = targetTokens;
            return "Compacted result";
        },
    };

    const capturedRequests: ModelRequest[] = [];
    const provider = createCaptureProvider(capturedRequests, async function* (_req, callIdx) {
        if (callIdx === 0) {
            yield {
                type: "tool_call",
                id: "c_override",
                name: "read",
                arguments: {},
            };
        } else {
            yield { type: "text", content: "Done" };
        }
    });

    // Tool returns 6,000 chars = ~1,500 tokens
    // Under runtime profile (20,000 capacity), this would NOT need compaction.
    // Under request profile (1,200 capacity), this MUST compact!
    const toolContent = "TOOL_DATA_RECORD_".repeat(350);

    const toolHost: RuntimeToolHost = {
        tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }],
        execute: async () => ({ content: toolContent }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        compactor,
        profile: runtimeProfile,
    });

    for await (const _ of runtime.run({
        items: [{ type: "message", role: "user", content: "Read data" }],
        profile: requestProfile,
    })) {
    }

    // Verify requestProfile won and triggered compaction
    assert.strictEqual(
        compactorInvoked,
        true,
        "Request profile must override runtime profile capacity and trigger compaction",
    );
    assert.ok(targetTokensReceived <= 1200);

    // Verify captured requests all carry requestProfile
    assert.strictEqual(capturedRequests.length, 2);
    assert.strictEqual(capturedRequests[0].profile, requestProfile);
    assert.strictEqual(capturedRequests[1].profile, requestProfile);
});

test("Regression D4: Request profile overrides Runtime profile charsPerToken", async () => {
    // Runtime has charsPerToken: 6 (dense)
    const runtimeProfile: ModelProfile = {
        id: "runtime-cpt-6",
        contextWindowTokens: 1500,
        maxOutputTokens: 100,
        safetyMarginTokens: 100,
        toolMode: "native",
        charsPerToken: 6,
    };

    // Request has charsPerToken: 2 (sparse)
    const requestProfile: ModelProfile = {
        id: "request-cpt-2",
        contextWindowTokens: 1500,
        maxOutputTokens: 100,
        safetyMarginTokens: 100,
        toolMode: "native",
        charsPerToken: 2,
    };

    // Available input capacity = 1500 - 100 - 100 = 1300 tokens
    // Tool returns 2,000 characters:
    // At charsPerToken: 6 -> 2000 / 6 = 334 tokens <= 1300 tokens (NO compaction needed)
    // At charsPerToken: 2 -> 2000 / 2 = 1000 tokens + prompt (400 chars = 200 tokens) + overhead -> exceeds or needs compaction
    // Let's use 2,800 chars:
    // At charsPerToken: 6 -> 467 tokens <= 1285 (fits easily)
    // At charsPerToken: 2 -> 1400 tokens + prompt (18 tokens) + tool_call (10 tokens) = 1432 > 1285 tokens (MUST compact!)
    const toolContent = "ABCDEFGHIJ".repeat(280); // 2800 chars

    let compactorInvoked = false;
    const compactor: ContextCompactor = {
        compactHistory: async () => null,
        compactToolResult: async () => {
            compactorInvoked = true;
            return "Compacted to fit";
        },
    };

    const capturedRequests: ModelRequest[] = [];
    const provider = createCaptureProvider(capturedRequests, async function* (_req, callIdx) {
        if (callIdx === 0) {
            yield {
                type: "tool_call",
                id: "c_cpt",
                name: "dense_tool",
                arguments: {},
            };
        } else {
            yield { type: "text", content: "Done" };
        }
    });

    const toolHost: RuntimeToolHost = {
        tools: [{ name: "dense_tool", description: "d", inputSchema: { type: "object" } }],
        execute: async () => ({ content: toolContent }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        compactor,
        profile: runtimeProfile,
    });

    for await (const _ of runtime.run({
        items: [{ type: "message", role: "user", content: "Test charsPerToken override" }],
        profile: requestProfile,
    })) {
    }

    assert.strictEqual(
        compactorInvoked,
        true,
        "Request profile charsPerToken (2) must govern compaction calculation, causing compaction",
    );
    assert.strictEqual(capturedRequests[0].profile, requestProfile);
    assert.strictEqual(capturedRequests[1].profile, requestProfile);
});

test("Regression D5: Legacy budget without an explicit profile", async () => {
    const budget: ContextBudget = {
        preferredInputTokens: 2000,
        reservedOverheadTokens: 200,
        minimumRecentHistoryTokens: 200,
    };

    const capturedRequests: ModelRequest[] = [];
    const provider = createCaptureProvider(capturedRequests, async function* (_req, callIdx) {
        if (callIdx === 0) {
            yield {
                type: "tool_call",
                id: "c_legacy",
                name: "legacy_tool",
                arguments: {},
            };
        } else {
            yield { type: "text", content: "Done" };
        }
    });

    const toolHost: RuntimeToolHost = {
        tools: [{ name: "legacy_tool", description: "l", inputSchema: { type: "object" } }],
        execute: async () => ({ content: "Normal tool result" }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        budget,
    });

    for await (const _ of runtime.run({
        items: [{ type: "message", role: "user", content: "Hello" }],
    })) {
    }

    assert.strictEqual(capturedRequests.length, 2);
    assert.strictEqual(capturedRequests[0].profile, undefined);
    assert.strictEqual(capturedRequests[1].profile, undefined);
});

// ============================================================================
// Group E: Compatibility and Failure Handling
// ============================================================================

test("Regression E1: Native tool calling remains correct and captures valid request structure", async () => {
    const profile: ModelProfile = {
        id: "native-prof",
        contextWindowTokens: 4000,
        maxOutputTokens: 500,
        safetyMarginTokens: 500,
        toolMode: "native",
        charsPerToken: 4,
    };

    const capturedRequests: ModelRequest[] = [];
    const provider = createCaptureProvider(capturedRequests, async function* (_req, callIdx) {
        if (callIdx === 0) {
            yield {
                type: "tool_call",
                id: "nat_1",
                name: "native_fn",
                arguments: { query: "search" },
            };
        } else {
            yield { type: "text", content: "Native execution finished." };
        }
    });

    const toolHost: RuntimeToolHost = {
        tools: [{ name: "native_fn", description: "fn", inputSchema: { type: "object" } }],
        execute: async () => ({ content: "native result" }),
    };

    const runtime = createAkkcoRuntime(provider, { toolHost, profile });

    for await (const _ of runtime.run({
        items: [{ type: "message", role: "user", content: "run native" }],
        profile,
    })) {
    }

    assert.strictEqual(capturedRequests.length, 2);
    assert.strictEqual(capturedRequests[0].tools?.length, 1);
    assert.strictEqual(capturedRequests[1].items.length, 3);
    assert.strictEqual(capturedRequests[1].items[1].type, "tool_call");
    assert.strictEqual(capturedRequests[1].items[2].type, "tool_result");
});

test("Regression E2: Compatibility mode envelopes remain valid and fit within budget", async () => {
    const profile: ModelProfile = {
        id: "compat-prof",
        contextWindowTokens: 4000,
        maxOutputTokens: 500,
        safetyMarginTokens: 500,
        toolMode: "compatibility",
        charsPerToken: 4,
    };

    const innerCapturedRequests: ModelRequest[] = [];
    const innerProvider = createCaptureProvider(
        innerCapturedRequests,
        async function* (_req, callIdx) {
            if (callIdx === 0) {
                // Emulate model emitting textual compatibility envelope
                yield {
                    type: "text",
                    content:
                        'Analyzing request...\n<akkco_tool_call>\n{"name":"read_cfg","arguments":{"key":"timeout"}}\n</akkco_tool_call>',
                };
            } else {
                yield {
                    type: "text",
                    content: "Configuration timeout is 30s.",
                };
            }
        },
    );

    const compatibilityProvider = createTextToolCompatibilityProvider(innerProvider);

    const toolHost: RuntimeToolHost = {
        tools: [{ name: "read_cfg", description: "read cfg", inputSchema: { type: "object" } }],
        execute: async () => ({ content: '{"timeout":30}' }),
    };

    const runtime = createAkkcoRuntime(compatibilityProvider, { toolHost, profile });

    const events: RuntimeEvent[] = [];
    for await (const ev of runtime.run({
        items: [{ type: "message", role: "user", content: "Check timeout" }],
        profile,
    })) {
        events.push(ev);
    }

    // Verify compatibility provider transformed request for the inner provider
    assert.strictEqual(innerCapturedRequests.length, 2);

    // First request: tools converted to system prompt instruction, tools stripped
    const req1 = innerCapturedRequests[0];
    assert.strictEqual(req1.tools, undefined);
    const systemToolInst = req1.items.find(
        (it) => it.type === "message" && it.role === "system" && (it as any).isToolInstruction,
    );
    assert.ok(systemToolInst, "Must have tool instruction system message");

    // Second request: previous tool call formatted as assistant message, tool result as user envelope
    const req2 = innerCapturedRequests[1];
    const toolResultMsg = req2.items.find(
        (it) => it.type === "message" && (it as any).content.includes("<akkco_tool_result"),
    );
    assert.ok(toolResultMsg, "Must have <akkco_tool_result> message envelope in second request");

    // Runtime events include text and tool execution
    const toolExecEvent = events.find((ev) => ev.type === "tool_execution");
    assert.ok(toolExecEvent);
    if (toolExecEvent.type === "tool_execution") {
        assert.strictEqual(toolExecEvent.toolName, "read_cfg");
        assert.strictEqual(toolExecEvent.status, "completed");
    }
});

test("Regression E3: Compaction failure does not re-execute tool, and fails closed with ContextBudgetOverflowError", async () => {
    const profile: ModelProfile = {
        id: "fail-closed-prof",
        contextWindowTokens: 1000,
        maxOutputTokens: 100,
        safetyMarginTokens: 100,
        toolMode: "native",
        charsPerToken: 4,
    };

    let toolExecutionCount = 0;
    const toolHost: RuntimeToolHost = {
        tools: [{ name: "fragile_tool", description: "ft", inputSchema: { type: "object" } }],
        execute: async () => {
            toolExecutionCount++;
            // 4,000 chars = 1,000 tokens > 800 input capacity
            return { content: "VERY_LARGE_TOOL_OUTPUT_".repeat(170) };
        },
    };

    // Compactor that fails (returns null or throws)
    let compactionAttemptCount = 0;
    const failingCompactor: ContextCompactor = {
        compactHistory: async () => null,
        compactToolResult: async () => {
            compactionAttemptCount++;
            throw new Error("Compactor network failure");
        },
    };

    const capturedRequests: ModelRequest[] = [];
    const provider = createCaptureProvider(capturedRequests, async function* () {
        yield {
            type: "tool_call",
            id: "call_fail_compact",
            name: "fragile_tool",
            arguments: {},
        };
    });

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        compactor: failingCompactor,
        profile,
    });

    // Generator must fail closed with ContextBudgetOverflowError on next request preflight
    await assert.rejects(
        async () => {
            for await (const _ of runtime.run({
                items: [{ type: "message", role: "user", content: "Run fragile tool" }],
                profile,
            })) {
            }
        },
        (err: any) => {
            assert.strictEqual(err.name, "ContextBudgetOverflowError");
            return true;
        },
    );

    // Tool was executed exactly ONCE (never re-executed after compaction failure!)
    assert.strictEqual(toolExecutionCount, 1, "Tool must not be re-executed on compaction failure");
    assert.strictEqual(compactionAttemptCount, 1, "Compactor was called once");
});

test("Regression E4: Context-overflow error is NOT reported as a tool-execution failure", async () => {
    const profile: ModelProfile = {
        id: "overflow-not-tool-err",
        contextWindowTokens: 800,
        maxOutputTokens: 100,
        safetyMarginTokens: 100,
        toolMode: "native",
        charsPerToken: 4,
    };

    const toolHost: RuntimeToolHost = {
        tools: [{ name: "big_tool", description: "bt", inputSchema: { type: "object" } }],
        execute: async () => {
            // Returns cleanly (tool succeeded), but result is too large for context
            return { content: "TOOL_SUCCEEDED_BUT_TOO_BIG_".repeat(100) };
        },
    };

    // No compactor provided -> cannot compact
    const provider = createCaptureProvider([], async function* () {
        yield {
            type: "tool_call",
            id: "call_big",
            name: "big_tool",
            arguments: {},
        };
    });

    const runtime = createAkkcoRuntime(provider, { toolHost, profile });

    const emittedEvents: RuntimeEvent[] = [];
    let thrownError: any;
    try {
        for await (const ev of runtime.run({
            items: [{ type: "message", role: "user", content: "Run big tool" }],
            profile,
        })) {
            emittedEvents.push(ev);
        }
    } catch (err) {
        thrownError = err;
    }

    // 1. Tool execution event was yielded with status: "completed" (NOT "failed"!)
    const toolEvent = emittedEvents.find((ev) => ev.type === "tool_execution");
    assert.ok(toolEvent, "Must emit tool_execution event");
    if (toolEvent.type === "tool_execution") {
        assert.strictEqual(
            toolEvent.status,
            "completed",
            "Tool execution must be reported as completed",
        );
    }

    // 2. The subsequent error is ContextBudgetOverflowError
    assert.ok(thrownError, "Must throw error");
    assert.strictEqual(thrownError.name, "ContextBudgetOverflowError");
});

test("Regression E5: Cancellation during compaction cleanly propagates AbortError", async () => {
    const profile: ModelProfile = {
        id: "cancel-prof",
        contextWindowTokens: 1000,
        maxOutputTokens: 100,
        safetyMarginTokens: 100,
        toolMode: "native",
        charsPerToken: 4,
    };

    const controller = new AbortController();

    const compactor: ContextCompactor = {
        compactHistory: async () => null,
        compactToolResult: async () => {
            // Signal aborted during compaction
            controller.abort();
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            throw err;
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [{ name: "tool_cancel", description: "tc", inputSchema: { type: "object" } }],
        execute: async () => ({ content: "Oversized content ".repeat(100) }),
    };

    const provider = createCaptureProvider([], async function* () {
        yield {
            type: "tool_call",
            id: "call_cancel",
            name: "tool_cancel",
            arguments: {},
        };
    });

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        compactor,
        profile,
    });

    await assert.rejects(
        async () => {
            for await (const _ of runtime.run({
                items: [{ type: "message", role: "user", content: "Run" }],
                signal: controller.signal,
                profile,
            })) {
            }
        },
        (err: any) => err.name === "AbortError" || /aborted/i.test(err.message),
    );
});
