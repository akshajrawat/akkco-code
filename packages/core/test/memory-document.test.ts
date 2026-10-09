import assert from "node:assert/strict";
import test from "node:test";
import {
    createMemoryDocumentFromTurn,
    deriveMemoryDocumentsFromTranscript,
    type TranscriptItem,
} from "../src/index.js";

test("memoryDocument: deterministic grouping of completed user turn with tool activity", () => {
    const turn: TranscriptItem[] = [
        { type: "user", content: "Check database configuration" },
        {
            type: "tool_execution",
            callId: "call_1",
            toolName: "read_file",
            arguments: { path: "packages/retrieval/src/sqlite/database.ts" },
            result: "const db = new DatabaseSync(... giant 1000 lines ...)",
            status: "completed",
        },
        {
            type: "tool_execution",
            callId: "call_2",
            toolName: "search_text",
            arguments: { query: "PRAGMA foreign_keys" },
            result: "found 50 matches across 20 files ...",
            status: "completed",
        },
        {
            type: "assistant",
            content: "The database enables foreign keys by default.",
            status: "completed",
        },
    ];

    const doc = createMemoryDocumentFromTurn(turn, 0, 3);
    assert.ok(doc);
    assert.equal(doc.startSequence, 0);
    assert.equal(doc.endSequence, 3);

    // User request is represented
    assert.ok(doc.content.includes("User: Check database configuration"));

    // Tool names and arguments are represented concisely
    assert.ok(doc.content.includes("Tool Activity:"));
    assert.ok(doc.content.includes("read packages/retrieval/src/sqlite/database.ts"));
    assert.ok(doc.content.includes('searched "PRAGMA foreign_keys"'));

    // Giant raw tool results are NOT copied wholesale
    assert.ok(!doc.content.includes("giant 1000 lines"));
    assert.ok(!doc.content.includes("found 50 matches"));

    // Final assistant answer is represented
    assert.ok(doc.content.includes("Assistant: The database enables foreign keys by default."));
});

test("memoryDocument: handles interrupted or failed turns intentionally by omitting them", () => {
    const interruptedTurn: TranscriptItem[] = [
        { type: "user", content: "Do something risky" },
        {
            type: "assistant",
            content: "Starting operation...",
            status: "interrupted",
        },
    ];

    const failedTurn: TranscriptItem[] = [
        { type: "user", content: "Do something that crashes" },
        {
            type: "assistant",
            content: "Fatal error",
            status: "failed",
        },
    ];

    assert.equal(createMemoryDocumentFromTurn(interruptedTurn, 0, 1), null);
    assert.equal(createMemoryDocumentFromTurn(failedTurn, 2, 3), null);
});

test("memoryDocument: same transcript produces byte-identical retrieval documents", () => {
    const transcript: TranscriptItem[] = [
        { type: "user", content: "Turn 1 request" },
        { type: "assistant", content: "Turn 1 answer", status: "completed" },
        { type: "user", content: "Turn 2 request" },
        {
            type: "tool_execution",
            callId: "call_t2",
            toolName: "list_files",
            arguments: { path: "src" },
            status: "completed",
            result: "file1, file2",
        },
        { type: "assistant", content: "Turn 2 answer", status: "completed" },
    ];

    const docsA = deriveMemoryDocumentsFromTranscript(transcript);
    const docsB = deriveMemoryDocumentsFromTranscript(transcript);

    assert.equal(docsA.length, 2);
    assert.deepEqual(docsA, docsB);
    assert.equal(docsA[0].content, docsB[0].content);
    assert.equal(docsA[1].content, docsB[1].content);
});
