import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEvent, ModelProvider, ModelRequest } from "@akkco/models";
import {
    createAkkcoRuntime,
    createAkkcoSession,
    createMilestoneProcessor,
    findMilestoneByCallId,
    recoverMilestoneEvidence,
    type RuntimeToolHost,
    type TranscriptItem,
} from "../src/index.js";

test("Evidence integrity: Raw tool output remains recoverable via recoverMilestoneEvidence and findMilestoneByCallId", async () => {
    const rawCode =
        "function authenticateUser(token: string): boolean { return token.startsWith('valid_'); }";
    let turn = 0;
    const provider: ModelProvider = {
        id: "mock-provider",
        stream: () => {
            turn++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (turn === 1) {
                        yield {
                            type: "tool_call",
                            id: "call_auth_123",
                            name: "read_file",
                            arguments: { path: "src/auth.ts" },
                        } satisfies ModelEvent;
                    } else {
                        yield {
                            type: "text",
                            content: "Auth logic inspected.",
                        } satisfies ModelEvent;
                    }
                },
            };
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [],
        execute: async () => ({ content: rawCode }),
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        milestones: true,
    });

    const session = createAkkcoSession(runtime);
    for await (const _ of session.send("Inspect authentication")) {
    }

    const transcript = session.transcript;
    const toolItem = transcript.find((it) => it.type === "tool_execution");
    assert.ok(toolItem && toolItem.type === "tool_execution");

    // 1. Raw output in canonical transcript remains untouched and unmutated
    assert.equal(toolItem.result, rawCode);

    // 2. recoverMilestoneEvidence recovers the full raw content by call ID
    const recoveredByCallId = recoverMilestoneEvidence(transcript, "call_auth_123");
    assert.equal(recoveredByCallId, rawCode);

    // 3. recoverMilestoneEvidence recovers the full raw content by milestone ID
    const recoveredByMilestoneId = recoverMilestoneEvidence(transcript, "milestone-call_auth_123");
    assert.equal(recoveredByMilestoneId, rawCode);

    // 4. findMilestoneByCallId retrieves the structured milestone
    const milestone = findMilestoneByCallId(transcript, "call_auth_123");
    assert.ok(milestone);
    assert.equal(milestone.callId, "call_auth_123");
    assert.equal(milestone.executionStatus, "completed");
    assert.equal(milestone.processingStatus, "completed");
    assert.deepEqual(milestone.evidenceRefs, ["call:call_auth_123"]);
});

test("Evidence integrity: Milestone references identify the correct source execution", async () => {
    const processor = createMilestoneProcessor();
    const milestone = await processor.processToolExecution({
        parentGoal: "Check status",
        parentGoalId: "goal-1",
        callId: "call_custom_99",
        toolName: "list_files",
        arguments: { path: "docs" },
        rawResult: "guide.md\napi.md",
        executionStatus: "completed",
    });

    assert.equal(milestone.id, "milestone-call_custom_99");
    assert.equal(milestone.callId, "call_custom_99");
    assert.deepEqual(milestone.evidenceRefs, ["call:call_custom_99"]);
    assert.equal(milestone.toolName, "list_files");
    assert.deepEqual(milestone.arguments, { path: "docs" });
});

test("Evidence integrity: Summaries never silently replace raw evidence", async () => {
    const hugeToolOutput = "Line " + "0123456789\n".repeat(500); // 5500 chars

    // Summarizer provider that produces a concise summary
    const summarizerProvider: ModelProvider = {
        id: "mock-summarizer",
        stream: () => {
            return (async function* () {
                yield {
                    type: "text",
                    content: JSON.stringify({
                        summary: "Output contains 500 lines of digit patterns.",
                        findings: ["Observed regular sequence of numbers"],
                        sourceLocations: [],
                        omissions: "500 repeated lines were omitted.",
                    }),
                } satisfies ModelEvent;
            })();
        },
    };

    const processor = createMilestoneProcessor({
        provider: summarizerProvider,
        deterministicThresholdTokens: 50, // Force AI summarization path
    });

    const milestone = await processor.processToolExecution({
        parentGoal: "Analyze output patterns",
        parentGoalId: "goal-2",
        callId: "call_dense_1",
        toolName: "fetch_logs",
        arguments: {},
        rawResult: hugeToolOutput,
        executionStatus: "completed",
    });

    // Milestone summary is compact and bounded
    assert.equal(milestone.summary, "Output contains 500 lines of digit patterns.");
    assert.notEqual(milestone.summary, hugeToolOutput);
    assert.ok(milestone.omissions?.includes("500 repeated lines were omitted"));

    // Raw evidence remains separate and explicitly referenced
    assert.deepEqual(milestone.evidenceRefs, ["call:call_dense_1"]);
});

test("Evidence integrity: Invalid or unsupported summarizer output is handled safely without inventing findings", async () => {
    const rawResult = "Error: Database connection refused at postgres://localhost:5432";

    // Summarizer that returns non-JSON garbled text
    const badSummarizerProvider: ModelProvider = {
        id: "mock-bad-summarizer",
        stream: () => {
            return (async function* () {
                yield {
                    type: "text",
                    content: "This is NOT valid JSON and cannot be parsed",
                } satisfies ModelEvent;
            })();
        },
    };

    const processor = createMilestoneProcessor({
        provider: badSummarizerProvider,
        deterministicThresholdTokens: 5, // Force AI path
    });

    const milestone = await processor.processToolExecution({
        parentGoal: "Connect to database",
        parentGoalId: "goal-3",
        callId: "call_bad_json",
        toolName: "connect_db",
        arguments: {},
        rawResult,
        executionStatus: "completed",
    });

    // Must NOT silently mark as verified completed milestone!
    assert.equal(milestone.executionStatus, "completed");
    assert.equal(milestone.processingStatus, "failed");
    assert.ok(milestone.summary.includes("connect_db"));
    assert.ok(milestone.findings[0].includes("Database connection refused"));
    assert.ok(milestone.omissions?.includes("AI summarization was not completed"));
    assert.deepEqual(milestone.evidenceRefs, ["call:call_bad_json"]);
});

test("Evidence integrity: Deterministic source verification drops fabricated paths", async () => {
    const rawToolOutput = "Found match in src/controllers/user.ts:45: user.login()";

    // Summarizer model hallucinates files that were NOT in the output
    const hallucinatingProvider: ModelProvider = {
        id: "mock-hallucinating-provider",
        stream: () => {
            return (async function* () {
                yield {
                    type: "text",
                    content: JSON.stringify({
                        summary: "Found login call in user controller.",
                        findings: ["user.login() found"],
                        sourceLocations: [
                            "src/controllers/user.ts:45", // Valid
                            "src/services/billing.ts:99", // Hallucinated! Does not exist in output!
                            "fake/directory/nonexistent.ts", // Hallucinated!
                        ],
                        omissions: "None.",
                    }),
                } satisfies ModelEvent;
            })();
        },
    };

    const processor = createMilestoneProcessor({
        provider: hallucinatingProvider,
        deterministicThresholdTokens: 5, // Force AI path
    });

    const milestone = await processor.processToolExecution({
        parentGoal: "Find login implementation",
        parentGoalId: "goal-4",
        callId: "call_hallucinate",
        toolName: "search_text",
        arguments: { query: "user.login" },
        rawResult: rawToolOutput,
        executionStatus: "completed",
    });

    // Must have dropped the hallucinated paths!
    assert.ok(milestone.sourceLocations);
    assert.equal(milestone.sourceLocations.length, 1);
    assert.equal(milestone.sourceLocations[0], "src/controllers/user.ts:45");
    assert.ok(!milestone.sourceLocations.includes("src/services/billing.ts:99"));
    assert.ok(!milestone.sourceLocations.includes("fake/directory/nonexistent.ts"));
});
