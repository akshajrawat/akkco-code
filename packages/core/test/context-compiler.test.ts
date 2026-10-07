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

test("compileContext: completed tool execution emits ModelToolCall and ModelToolResult", () => {
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
    assert.deepStrictEqual(items, [
        {
            type: "tool_call",
            id: "call_1",
            name: "read_file",
            arguments: { path: "src/index.ts" },
        },
        {
            type: "tool_result",
            callId: "call_1",
            content: "console.log('hello');",
        },
    ]);
});

test("compileContext: failed tool execution emits ModelToolCall and ModelToolResult with isError", () => {
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
    assert.deepStrictEqual(items, [
        {
            type: "tool_call",
            id: "call_2",
            name: "read_file",
            arguments: { path: "missing.txt" },
        },
        {
            type: "tool_result",
            callId: "call_2",
            content: "File not found: missing.txt",
            isError: true,
        },
    ]);
});

test("compileContext: cancelled tool execution emits ModelToolCall and ModelToolResult with isError", () => {
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
    assert.deepStrictEqual(items, [
        {
            type: "tool_call",
            id: "call_3",
            name: "search_text",
            arguments: { query: "foo" },
        },
        {
            type: "tool_result",
            callId: "call_3",
            content: "Tool execution cancelled",
            isError: true,
        },
    ]);
});

test("compileContext: requested and running tool execution emits only ModelToolCall", () => {
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
    assert.deepStrictEqual(items, [
        {
            type: "tool_call",
            id: "call_4",
            name: "list_files",
            arguments: { path: "." },
        },
        {
            type: "tool_call",
            id: "call_5",
            name: "list_files",
            arguments: { path: "src" },
        },
    ]);
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

    assert.deepStrictEqual(compiled, [
        { type: "message", role: "system", content: "System instructions" },
        { type: "message", role: "user", content: "Inspect repo" },
        {
            type: "tool_call",
            id: "call_1",
            name: "list_files",
            arguments: { path: "." },
        },
        {
            type: "tool_result",
            callId: "call_1",
            content: "file1.ts\nfile2.ts",
        },
        { type: "message", role: "assistant", content: "I see file1.ts and file2.ts." },
        { type: "message", role: "user", content: "Read file1" },
        {
            type: "tool_call",
            id: "call_2",
            name: "read_file",
            arguments: { path: "file1.ts" },
        },
        {
            type: "tool_result",
            callId: "call_2",
            content: "Tool execution cancelled",
            isError: true,
        },
        { type: "message", role: "assistant", content: "Cancelled early" },
        {
            type: "message",
            role: "system",
            content: "[Previous assistant generation was interrupted before completion]",
        },
    ]);
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

    assert.deepStrictEqual(compiled, [
        { type: "message", role: "system", content: AGENT_POLICY },
        { type: "message", role: "system", content: "Custom system prompt" },
        { type: "message", role: "user", content: "Inspect repo" },
        {
            type: "tool_call",
            id: "call_1",
            name: "list_files",
            arguments: { path: "." },
        },
        {
            type: "tool_result",
            callId: "call_1",
            content: "file1.ts\nfile2.ts",
        },
        { type: "message", role: "assistant", content: "I see file1.ts and file2.ts." },
    ]);
});
