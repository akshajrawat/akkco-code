import assert from "node:assert/strict";
import test from "node:test";
import type { ModelItem, ModelProfile, ModelRequest, ModelTool } from "@akkco/models";
import {
    calculateMaxInputTokens,
    ContextBudgetOverflowError,
    deriveContextBudget,
    prepareBoundedModelRequest,
    type ContextBudget,
} from "../src/index.js";

const sampleProfile: ModelProfile = {
    id: "test-profile",
    contextWindowTokens: 8192,
    maxOutputTokens: 1024,
    safetyMarginTokens: 256,
    toolMode: "compatibility",
    charsPerToken: 4,
};

test("Core Budgeting: calculateMaxInputTokens computes correct capacity", () => {
    const maxInput = calculateMaxInputTokens(sampleProfile);
    assert.strictEqual(maxInput, 8192 - 1024 - 256);
    assert.strictEqual(maxInput, 6912);
});

test("Core Budgeting: deriveContextBudget derives valid ContextBudget from profile", () => {
    const budget = deriveContextBudget(sampleProfile);
    assert.strictEqual(budget.preferredInputTokens, 6912);
    assert.ok(budget.reservedOverheadTokens <= 1024);
    assert.ok(budget.preferredInputTokens > budget.reservedOverheadTokens);
});

test("Core Budgeting: prepareBoundedModelRequest respects profile capacity", () => {
    const request: ModelRequest = {
        items: [
            { type: "message", role: "system", content: "Mandatory system policy" },
            { type: "message", role: "user", content: "Active prompt" },
        ],
        profile: sampleProfile,
    };

    const prepared = prepareBoundedModelRequest({ request });
    assert.strictEqual(prepared.items.length, 2);
    assert.strictEqual(prepared.profile?.id, "test-profile");
});

test("Core Budgeting: non-mutation guarantee leaves input request untouched", () => {
    const originalItems: ModelItem[] = [
        { type: "message", role: "system", content: "Static policy" },
        { type: "message", role: "user", content: "Old question ".repeat(50) },
        { type: "message", role: "assistant", content: "Old answer ".repeat(50) },
        { type: "message", role: "user", content: "Active question" },
    ];

    const originalRequest: ModelRequest = {
        items: originalItems,
        profile: {
            id: "small-profile",
            contextWindowTokens: 300,
            maxOutputTokens: 50,
            safetyMarginTokens: 50,
            toolMode: "compatibility",
            charsPerToken: 4,
        },
    };

    const snapshot = JSON.stringify(originalRequest);

    const prepared = prepareBoundedModelRequest({ request: originalRequest });

    // Prepared trimmed history to fit small budget
    assert.ok(prepared.items.length < originalItems.length);
    // Original request must be completely unchanged
    assert.strictEqual(JSON.stringify(originalRequest), snapshot);
});

test("Core Budgeting: atomic historical turn trimming removes entire turns", () => {
    // Small budget forcing trimming of older turn
    const profile: ModelProfile = {
        id: "trim-profile",
        contextWindowTokens: 180,
        maxOutputTokens: 30,
        safetyMarginTokens: 30,
        toolMode: "native",
        charsPerToken: 4,
    };

    const items: ModelItem[] = [
        { type: "message", role: "system", content: "Policy" },
        // Historical Turn 1 (large)
        { type: "message", role: "user", content: "Turn 1 question ".repeat(15) },
        {
            type: "tool_call",
            id: "call_1",
            name: "read_file",
            arguments: { path: "a.txt" },
        },
        {
            type: "tool_result",
            callId: "call_1",
            content: "Result 1 ".repeat(15),
        },
        // Historical Turn 2 (small)
        { type: "message", role: "user", content: "Turn 2 question" },
        { type: "message", role: "assistant", content: "Turn 2 answer" },
        // Active Turn
        { type: "message", role: "user", content: "Active question" },
    ];

    const prepared = prepareBoundedModelRequest({
        request: { items, profile },
    });

    // Policy and active turn must be present
    assert.strictEqual(prepared.items[0].type, "message");
    assert.strictEqual(
        (prepared.items[prepared.items.length - 1] as any).content,
        "Active question",
    );

    // Check that Turn 1 was trimmed atomically - no orphaned call_1 tool_result or tool_call
    const hasCall1 = prepared.items.some((it) => it.type === "tool_call" && it.id === "call_1");
    const hasResult1 = prepared.items.some(
        (it) => it.type === "tool_result" && it.callId === "call_1",
    );
    assert.strictEqual(hasCall1, false);
    assert.strictEqual(hasResult1, false);
});

test("Core Budgeting: active user prompt and mandatory policy are never discarded", () => {
    const profile: ModelProfile = {
        id: "tight-profile",
        contextWindowTokens: 500,
        maxOutputTokens: 100,
        safetyMarginTokens: 50,
        toolMode: "compatibility",
        charsPerToken: 4,
    };

    const items: ModelItem[] = [
        { type: "message", role: "system", content: "Mandatory trusted policy" },
        { type: "message", role: "user", content: "Historical question ".repeat(30) },
        { type: "message", role: "assistant", content: "Historical answer ".repeat(30) },
        { type: "message", role: "user", content: "Crucial active prompt that must survive" },
    ];

    const prepared = prepareBoundedModelRequest({
        request: { items, profile },
    });

    assert.strictEqual((prepared.items[0] as any).content, "Mandatory trusted policy");
    const activeItem = prepared.items[prepared.items.length - 1] as any;
    assert.strictEqual(activeItem.content, "Crucial active prompt that must survive");
});

test("Core Budgeting: safe tool-result truncation for native and compatibility results", () => {
    const profile: ModelProfile = {
        id: "truncate-profile",
        contextWindowTokens: 300,
        maxOutputTokens: 50,
        safetyMarginTokens: 50,
        toolMode: "compatibility",
        charsPerToken: 4,
    };

    // Compatibility mode tool result envelope
    const items: ModelItem[] = [
        { type: "message", role: "system", content: "Policy" },
        { type: "message", role: "user", content: "Inspect large output" },
        {
            type: "message",
            role: "assistant",
            content:
                '<akkco_tool_call>\n{"name":"read_file","arguments":{"path":"huge.txt"}}\n</akkco_tool_call>',
        },
        {
            type: "message",
            role: "user",
            content: `<akkco_tool_result call_id="c123" status="success">\n${"x".repeat(2000)}\n</akkco_tool_result>`,
            toolResultEnvelope: {
                callId: "c123",
                status: "success",
                rawBody: "x".repeat(2000),
            },
        },
    ];

    const prepared = prepareBoundedModelRequest({
        request: { items, profile },
    });

    const lastItem = prepared.items[prepared.items.length - 1];
    assert.strictEqual(lastItem.type, "message");
    assert.ok(lastItem.content.includes('<akkco_tool_result call_id="c123" status="success">'));
    assert.ok(lastItem.content.includes("</akkco_tool_result>"));
    assert.ok(lastItem.content.includes("[Output truncated"));
});

test("Core Budgeting: fails closed with ContextBudgetOverflowError reporting details", () => {
    const tinyProfile: ModelProfile = {
        id: "tiny-profile",
        contextWindowTokens: 200,
        maxOutputTokens: 50,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };

    const items: ModelItem[] = [
        { type: "message", role: "system", content: "Mandatory policy ".repeat(30) },
        { type: "message", role: "user", content: "Mandatory user prompt ".repeat(30) },
    ];

    assert.throws(
        () =>
            prepareBoundedModelRequest({
                request: { items, profile: tinyProfile },
            }),
        (err: unknown) => {
            assert.ok(err instanceof ContextBudgetOverflowError);
            const msg = (err as Error).message;
            assert.ok(msg.includes("contextWindow=200"));
            assert.ok(msg.includes("maxOutput=50"));
            assert.ok(msg.includes("safetyMargin=50"));
            return true;
        },
    );
});

test("Core Budgeting: supports custom charsPerToken in profile", () => {
    const profile4: ModelProfile = {
        id: "profile-4",
        contextWindowTokens: 500,
        maxOutputTokens: 50,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 4,
    };

    const profile2: ModelProfile = {
        id: "profile-2",
        contextWindowTokens: 500,
        maxOutputTokens: 50,
        safetyMarginTokens: 50,
        toolMode: "native",
        charsPerToken: 2, // 2 chars per token -> double the estimated token count
    };

    const items: ModelItem[] = [
        { type: "message", role: "system", content: "Policy" },
        { type: "message", role: "user", content: "a".repeat(900) },
    ];

    // Under 4 chars/token: 900 / 4 = 225 tokens + 11 = 236 -> fits in 400 available
    const prep4 = prepareBoundedModelRequest({
        request: { items, profile: profile4 },
    });
    assert.strictEqual(prep4.items.length, 2);

    // Under 2 chars/token: 900 / 2 = 450 tokens + 11 = 461 > 400 available -> overflows
    assert.throws(
        () =>
            prepareBoundedModelRequest({
                request: { items, profile: profile2 },
            }),
        { name: "ContextBudgetOverflowError" },
    );
});

test("Core Budgeting: precedence when both explicit budget and profile are supplied", () => {
    const profile: ModelProfile = {
        id: "cap-profile",
        contextWindowTokens: 10000,
        maxOutputTokens: 1000,
        safetyMarginTokens: 500,
        toolMode: "native",
        charsPerToken: 4,
    };
    // Profile cap is 8500 tokens

    const explicitBudget: ContextBudget = {
        preferredInputTokens: 3000,
        reservedOverheadTokens: 200,
        minimumRecentHistoryTokens: 200,
    };

    const items: ModelItem[] = [
        { type: "message", role: "system", content: "Policy" },
        { type: "message", role: "user", content: "Question ".repeat(400) }, // ~3600 chars = ~900 tokens
    ];

    // Explicit budget of 3000 is used as stricter ceiling
    const prepared = prepareBoundedModelRequest({
        request: { items, profile },
        budget: explicitBudget,
    });
    assert.strictEqual(prepared.items.length, 2);

    // If explicit budget is too small (e.g. 100 tokens), it errors
    const tightBudget: ContextBudget = {
        preferredInputTokens: 150,
        reservedOverheadTokens: 50,
        minimumRecentHistoryTokens: 10,
    };

    assert.throws(
        () =>
            prepareBoundedModelRequest({
                request: { items, profile },
                budget: tightBudget,
            }),
        { name: "ContextBudgetOverflowError" },
    );
});
