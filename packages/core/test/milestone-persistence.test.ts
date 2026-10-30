import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEvent, ModelProvider, ModelRequest } from "@akkco/models";
import { SqliteConversationStore } from "@akkco/retrieval";
import {
    ConversationMemoryOrchestrator,
    createAkkcoRuntime,
    createAkkcoSession,
    type RuntimeToolHost,
    type ToolExecutionTranscriptItem,
} from "../src/index.js";

test("Persistence: Canonical transcripts persist tool executions with raw results and milestones in SQLite", async () => {
    const store = new SqliteConversationStore({ dbPath: ":memory:" });
    await store.initialize();
    const persistence = new ConversationMemoryOrchestrator(store);

    let turn = 0;
    const provider: ModelProvider = {
        id: "mock-persistence-provider",
        stream: () => {
            turn++;
            if (turn === 1) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_persist_1",
                        name: "read_file",
                        arguments: { path: "hello.txt" },
                    } satisfies ModelEvent;
                })();
            }
            return (async function* () {
                yield { type: "text", content: "Persistence verified." } satisfies ModelEvent;
            })();
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "Hello from persistent storage!" }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
    });

    const session = createAkkcoSession(runtime, [], {
        persistence,
    });

    for await (const _ of session.send("Read hello.txt")) {
    }

    // 1. In-memory session transcript has milestone and raw result
    const inMemoryTranscript = session.transcript;
    assert.equal(inMemoryTranscript.length, 3); // user, tool_execution, assistant
    const inMemTool = inMemoryTranscript[1] as ToolExecutionTranscriptItem;
    assert.equal(inMemTool.type, "tool_execution");
    assert.equal(inMemTool.result, "Hello from persistent storage!");
    assert.ok(inMemTool.milestone);
    assert.equal(inMemTool.milestone.callId, "call_persist_1");

    // 2. Persisted SQLite records reflect exact canonical transcript
    const persistedRecords = await store.getTranscriptItems(session.id);
    assert.equal(persistedRecords.length, 3);
    assert.equal(persistedRecords[1].type, "tool_execution");

    const parsedPayload = JSON.parse(persistedRecords[1].payload);
    assert.equal(parsedPayload.type, "tool_execution");
    assert.equal(parsedPayload.callId, "call_persist_1");
    assert.equal(parsedPayload.result, "Hello from persistent storage!");
    assert.ok(parsedPayload.milestone);
    assert.equal(parsedPayload.milestone.callId, "call_persist_1");
    assert.equal(parsedPayload.milestone.executionStatus, "completed");
    assert.equal(parsedPayload.milestone.processingStatus, "completed");

    // 3. Session restoration from persisted items preserves milestone without fabrication or duplication
    const restoredSession = createAkkcoSession(
        runtime,
        persistedRecords.map((r) => JSON.parse(r.payload)),
        { id: session.id, persistence, initialSequence: persistedRecords.length },
    );

    const restoredTranscript = restoredSession.transcript;
    assert.equal(restoredTranscript.length, 3);
    const restoredTool = restoredTranscript[1] as ToolExecutionTranscriptItem;
    assert.equal(restoredTool.type, "tool_execution");
    assert.equal(restoredTool.callId, "call_persist_1");
    assert.equal(restoredTool.result, "Hello from persistent storage!");
    assert.ok(restoredTool.milestone);
    assert.equal(restoredTool.milestone.callId, "call_persist_1");

    await store.close();
});

test("Persistence: History RAG is executed once per user turn and not repeated during autonomous tool calls", async () => {
    let ragRetrievalCount = 0;
    const mockRetriever = {
        retrieve: async () => {
            ragRetrievalCount++;
            return [];
        },
    };

    let toolCallsCount = 0;
    const provider: ModelProvider = {
        id: "mock-rag-provider",
        stream: () => {
            toolCallsCount++;
            if (toolCallsCount <= 2) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: `call_${toolCallsCount}`,
                        name: "check_item",
                        arguments: { step: toolCallsCount },
                    } satisfies ModelEvent;
                })();
            }
            return (async function* () {
                yield { type: "text", content: "Done with both tool steps." } satisfies ModelEvent;
            })();
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: "step result" }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
    });

    const mockCompiler = {
        compile: async (input: any) => {
            await mockRetriever.retrieve();
            return [{ type: "message" as const, role: "user" as const, content: "Do steps" }];
        },
    };

    const session = createAkkcoSession(runtime, [], {
        compiler: mockCompiler as any,
    });

    for await (const _ of session.send("Do steps")) {
    }

    // Verify tool execution loop executed multiple internal iterations (2 tool calls + 1 final answer = 3 provider calls)
    assert.equal(toolCallsCount, 3);

    // CRITICAL: History RAG retrieval must only have been invoked ONCE for the user turn, NEVER during tool loop!
    assert.equal(ragRetrievalCount, 1);
});
