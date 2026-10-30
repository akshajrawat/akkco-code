import assert from "node:assert";
import test from "node:test";
import { compileContext } from "../src/index.js";
import { AGENT_POLICY } from "../src/context/context-compiler.js";
import type {
    AssistantTranscriptItem,
    SystemTranscriptItem,
    ToolExecutionTranscriptItem,
    TranscriptItem,
    UserTranscriptItem,
} from "../src/index.js";

const compileWithoutPolicy = (transcript: TranscriptItem[]) =>
    compileContext(transcript, { includePolicy: false });

test("compileContext: system item compilation", () => {
    const transcript: SystemTranscriptItem[] = [
        { type: "system", content: "You are a helpful coding assistant." },
    ];
    const items = compileWithoutPolicy(transcript);
    assert.deepStrictEqual(items, [
        { type: "message", role: "system", content: "You are a helpful coding assistant." },
    ]);
});

test("compileContext: user item compilation", () => {
    const transcript: UserTranscriptItem[] = [{ type: "user", content: "Write a function" }];
    const items = compileWithoutPolicy(transcript);
    assert.deepStrictEqual(items, [{ type: "message", role: "user", content: "Write a function" }]);
});

test("compileContext: completed assistant item compilation", () => {
    const transcript: AssistantTranscriptItem[] = [
        { type: "assistant", content: "Here is your code.", status: "completed" },
    ];
    const items = compileWithoutPolicy(transcript);
    assert.deepStrictEqual(items, [
        { type: "message", role: "assistant", content: "Here is your code." },
    ]);
});

test("compileContext: interrupted assistant with non-empty content includes partial message and compact system notice", () => {
    const transcript: AssistantTranscriptItem[] = [
        { type: "assistant", content: "Partial code...", status: "interrupted" },
    ];
    const items = compileWithoutPolicy(transcript);
    assert.deepStrictEqual(items, [
        { type: "message", role: "assistant", content: "Partial code..." },
        {
            type: "message",
            role: "system",
            content: "[Previous assistant generation was interrupted before completion]",
        },
    ]);
});

test("compileContext: interrupted assistant with empty content emits only the compact system notice", () => {
    const transcript: AssistantTranscriptItem[] = [
        { type: "assistant", content: "", status: "interrupted" },
    ];
    const items = compileWithoutPolicy(transcript);
    assert.deepStrictEqual(items, [
        {
            type: "message",
            role: "system",
            content: "[Previous assistant generation was interrupted before completion]",
        },
    ]);
});

test("compileContext: failed assistant includes partial message (if any) and failure notice", () => {
    const transcriptWithContent: AssistantTranscriptItem[] = [
        { type: "assistant", content: "Halfway through...", status: "failed" },
    ];
    const items1 = compileWithoutPolicy(transcriptWithContent);
    assert.deepStrictEqual(items1, [
        { type: "message", role: "assistant", content: "Halfway through..." },
        {
            type: "message",
            role: "system",
            content: "[Previous assistant generation failed]",
        },
    ]);

    const transcriptEmpty: AssistantTranscriptItem[] = [
        { type: "assistant", content: "", status: "failed" },
    ];
    const items2 = compileWithoutPolicy(transcriptEmpty);
    assert.deepStrictEqual(items2, [
        {
            type: "message",
            role: "system",
            content: "[Previous assistant generation failed]",
        },
    ]);
});

test("compileContext: completed tool execution emits milestone ModelItem", () => {
    const transcript: ToolExecutionTranscriptItem[] = [
        {
            type: "tool_execution",
            callId: "call_1",
            toolName: "read_file",
            arguments: { path: "src/index.ts" },
            result: "console.log('hello');",
            status: "completed",
            durationMs: 42,
        },
    ];
    const items = compileWithoutPolicy(transcript);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, "message");
    assert.strictEqual(items[0].role, "user");
    assert.strictEqual((items[0] as any).isPolicy, false);
    assert.ok(items[0].content.includes("read_file") && items[0].content.includes("Did:"));
});

test("compileContext: tool execution with explicit milestone preserves complete milestone evidence", () => {
    const transcript: ToolExecutionTranscriptItem[] = [
        {
            type: "tool_execution",
            callId: "call_m1",
            toolName: "search_text",
            arguments: { query: "export" },
            result: "index.ts:1:export const a = 1;",
            status: "completed",
            durationMs: 12,
            milestone: {
                id: "milestone-call_m1",
                parentGoalId: "goal-1",
                callId: "call_m1",
                toolName: "search_text",
                arguments: { query: "export" },
                executionStatus: "completed",
                processingStatus: "completed",
                summary: "Found export declaration",
                findings: ["Exported symbol a in index.ts:1"],
                sourceLocations: ["index.ts:1"],
                evidenceRefs: ["call:call_m1"],
                estimatedTokens: 30,
            },
        },
    ];
    const items = compileWithoutPolicy(transcript);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, "message");
    assert.strictEqual(items[0].role, "user");
    assert.ok(items[0].content.includes("search_text") && items[0].content.includes("Did:"));
    assert.ok(items[0].content.includes("Exported symbol a in index.ts:1"));
});

test("compileContext: failed tool execution emits milestone ModelItem with failure summary", () => {
    const transcript: ToolExecutionTranscriptItem[] = [
        {
            type: "tool_execution",
            callId: "call_2",
            toolName: "read_file",
            arguments: { path: "missing.txt" },
            error: "File not found: missing.txt",
            status: "failed",
            durationMs: 15,
        },
    ];
    const items = compileWithoutPolicy(transcript);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, "message");
    assert.strictEqual(items[0].role, "user");
    assert.ok(items[0].content.includes("read_file") && items[0].content.includes("Did:"));
    assert.ok(items[0].content.includes("File not found: missing.txt"));
});

test("compileContext: cancelled tool execution emits milestone ModelItem with cancelled status", () => {
    const transcript: ToolExecutionTranscriptItem[] = [
        {
            type: "tool_execution",
            callId: "call_3",
            toolName: "search_text",
            arguments: { query: "foo" },
            status: "cancelled",
        },
    ];
    const items = compileWithoutPolicy(transcript);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, "message");
    assert.strictEqual(items[0].role, "user");
    assert.ok(items[0].content.includes("search_text") && items[0].content.includes("Cancelled"));
});

test("compileContext: requested and running tool execution compiles to milestone items", () => {
    const requestedItem: ToolExecutionTranscriptItem = {
        type: "tool_execution",
        callId: "call_4",
        toolName: "list_files",
        arguments: { path: "." },
        status: "requested",
    };
    const runningItem: ToolExecutionTranscriptItem = {
        type: "tool_execution",
        callId: "call_5",
        toolName: "list_files",
        arguments: { path: "src" },
        status: "running",
    };

    const items = compileWithoutPolicy([requestedItem, runningItem]);
    assert.strictEqual(items.length, 2);
    assert.ok(
        (items[0] as any).content.includes("list_files") &&
            (items[0] as any).content.includes("Did:"),
    );
    assert.ok(
        (items[1] as any).content.includes("list_files") &&
            (items[1] as any).content.includes("Did:"),
    );
});

test("compileContext F-017: incomplete tool record followed by interruption and new user message preserves valid sequencing", () => {
    const transcript: TranscriptItem[] = [
        { type: "user", content: "list files" },
        {
            type: "tool_execution",
            callId: "call_incomplete",
            toolName: "list_files",
            arguments: { path: "." },
            status: "running",
        },
        { type: "assistant", content: "", status: "interrupted" },
        { type: "user", content: "new question" },
    ];

    const items = compileWithoutPolicy(transcript);

    // Verify milestone is compiled before the interrupted notice and next user message
    assert.strictEqual(items.length, 4);
    assert.deepStrictEqual(items[0], { type: "message", role: "user", content: "list files" });
    assert.strictEqual(items[1].type, "message");
    assert.strictEqual(items[1].role, "user");
    assert.ok(items[1].content.includes("list_files") && items[1].content.includes("Did:"));
    assert.deepStrictEqual(items[2], {
        type: "message",
        role: "system",
        content: "[Previous assistant generation was interrupted before completion]",
    });
    assert.deepStrictEqual(items[3], { type: "message", role: "user", content: "new question" });
});

test("compileContext: durationMs and internal metadata are never exposed on ModelItem", () => {
    const item: ToolExecutionTranscriptItem = {
        type: "tool_execution",
        callId: "call_6",
        toolName: "read_file",
        arguments: {},
        result: "data",
        status: "completed",
        durationMs: 1234,
    };
    const compiled = compileWithoutPolicy([item]);
    for (const modelItem of compiled) {
        assert.strictEqual("durationMs" in modelItem, false);
        assert.strictEqual("status" in modelItem, false);
    }
});

test("compileContext: deterministic ordering across heterogeneous transcript", () => {
    const transcript: TranscriptItem[] = [
        { type: "system", content: "System instructions" },
        { type: "user", content: "Inspect repo" },
        {
            type: "tool_execution",
            callId: "call_1",
            toolName: "list_files",
            arguments: { path: "." },
            result: "file1.ts\nfile2.ts",
            status: "completed",
        },
        { type: "assistant", content: "I see file1.ts and file2.ts.", status: "completed" },
        { type: "user", content: "Read file1" },
        {
            type: "tool_execution",
            callId: "call_2",
            toolName: "read_file",
            arguments: { path: "file1.ts" },
            status: "cancelled",
        },
        { type: "assistant", content: "Cancelled early", status: "interrupted" },
    ];

    const compiled = compileWithoutPolicy(transcript);

    assert.strictEqual(compiled.length, 8);
    assert.deepStrictEqual(compiled[0], {
        type: "message",
        role: "system",
        content: "System instructions",
    });
    assert.deepStrictEqual(compiled[1], { type: "message", role: "user", content: "Inspect repo" });
    assert.ok(
        (compiled[2] as any).content.includes("list_files") &&
            (compiled[2] as any).content.includes("Did:"),
    );
    assert.deepStrictEqual(compiled[3], {
        type: "message",
        role: "assistant",
        content: "I see file1.ts and file2.ts.",
    });
    assert.deepStrictEqual(compiled[4], { type: "message", role: "user", content: "Read file1" });
    assert.ok(
        (compiled[5] as any).content.includes("read_file") &&
            (compiled[5] as any).content.includes("Cancelled"),
    );
    assert.deepStrictEqual(compiled[6], {
        type: "message",
        role: "assistant",
        content: "Cancelled early",
    });
    assert.deepStrictEqual(compiled[7], {
        type: "message",
        role: "system",
        content: "[Previous assistant generation was interrupted before completion]",
    });
});

test("compileContext: default compileContext prepends AGENT_POLICY once at index 0", () => {
    const transcript: UserTranscriptItem[] = [{ type: "user", content: "hello" }];
    const compiled = compileContext(transcript);
    assert.strictEqual(compiled.length, 2);
    assert.deepStrictEqual(compiled[0], {
        type: "message",
        role: "system",
        content: AGENT_POLICY,
    });
    assert.deepStrictEqual(compiled[1], {
        type: "message",
        role: "user",
        content: "hello",
    });
});

test("compileContext: does not duplicate AGENT_POLICY if already present in transcript", () => {
    const transcript: TranscriptItem[] = [
        { type: "system", content: AGENT_POLICY },
        { type: "user", content: "hello" },
    ];
    const compiled = compileContext(transcript);
    assert.strictEqual(compiled.length, 2);
    assert.deepStrictEqual(compiled[0], {
        type: "message",
        role: "system",
        content: AGENT_POLICY,
    });
    assert.deepStrictEqual(compiled[1], {
        type: "message",
        role: "user",
        content: "hello",
    });
});

test("compileContext: preserves deterministic transcript ordering when AGENT_POLICY is present", () => {
    const transcript: TranscriptItem[] = [
        { type: "system", content: "Custom system prompt" },
        { type: "user", content: "Inspect repo" },
        {
            type: "tool_execution",
            callId: "call_1",
            toolName: "list_files",
            arguments: { path: "." },
            result: "file1.ts\nfile2.ts",
            status: "completed",
        },
        { type: "assistant", content: "I see file1.ts and file2.ts.", status: "completed" },
    ];

    const compiled = compileContext(transcript);

    assert.equal(compiled.length, 5);
    assert.deepStrictEqual(compiled[0], { type: "message", role: "system", content: AGENT_POLICY });
    assert.deepStrictEqual(compiled[1], {
        type: "message",
        role: "system",
        content: "Custom system prompt",
    });
    assert.deepStrictEqual(compiled[2], { type: "message", role: "user", content: "Inspect repo" });
    assert.equal(compiled[3].type, "message");
    assert.equal((compiled[3] as any).role, "user");
    assert.ok(
        (compiled[3] as any).content.includes("list_files") &&
            (compiled[3] as any).content.includes("Did:"),
    );
    assert.deepStrictEqual(compiled[4], {
        type: "message",
        role: "assistant",
        content: "I see file1.ts and file2.ts.",
    });
});
