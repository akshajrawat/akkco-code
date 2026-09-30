import assert from "node:assert";
import test from "node:test";
import { FakeModelProvider } from "../src/testing/index.js";
import type {
    ModelEvent,
    ModelItem,
    ModelMessage,
    ModelRequest,
    ModelTextEvent,
    ModelTool,
    ModelToolCall,
    ModelToolCallEvent,
    ModelToolResult,
} from "../src/index.js";

test("ModelItem discriminated union covers message, tool_call, and tool_result", () => {
    const message: ModelMessage = {
        type: "message",
        role: "user",
        content: "hello",
    };
    const toolCall: ModelToolCall = {
        type: "tool_call",
        id: "call_123",
        name: "read_file",
        arguments: { path: "foo.txt" },
    };
    const toolResult: ModelToolResult = {
        type: "tool_result",
        callId: "call_123",
        content: "file content",
        isError: false,
    };

    const items: ModelItem[] = [message, toolCall, toolResult];
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].type, "message");
    assert.strictEqual(items[1].type, "tool_call");
    assert.strictEqual(items[2].type, "tool_result");
});

test("ModelTool contract is independent and provider-neutral", () => {
    const tool: ModelTool = {
        name: "test_tool",
        description: "A provider-neutral tool",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
    };
    assert.strictEqual(tool.name, "test_tool");
});

test("ModelEvent discriminated union handles text and tool_call", () => {
    const textEvent: ModelTextEvent = { type: "text", content: "chunk" };
    const toolCallEvent: ModelToolCallEvent = {
        type: "tool_call",
        id: "call_abc",
        name: "search_text",
        arguments: { query: "test" },
    };

    const events: ModelEvent[] = [textEvent, toolCallEvent];
    assert.strictEqual(events[0].type, "text");
    assert.strictEqual(events[1].type, "tool_call");
});

test("FakeModelProvider streams responses based on ModelRequest items", async () => {
    const provider = new FakeModelProvider();
    const request: ModelRequest = {
        items: [{ type: "message", role: "user", content: "ping" }],
    };

    const chunks: string[] = [];
    for await (const event of provider.stream(request)) {
        if (event.type === "text") {
            chunks.push(event.content);
        }
    }

    assert.strictEqual(chunks.join("").trim(), "Fake response to ping");
});
