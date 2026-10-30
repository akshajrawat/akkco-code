import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEvent, ModelMessage, ModelProvider, ModelRequest } from "@akkco/models";
import {
    createAkkcoRuntime,
    createAkkcoSession,
    recoverMilestoneEvidence,
    type RuntimeEvent,
    type RuntimeToolHost,
} from "../src/index.js";

test("Realistic Integration: 'Explain what TextToolCompatibilityProvider does, why it is important, and suggest one concrete source-backed improvement.'", async () => {
    const PROMPT =
        "Explain what TextToolCompatibilityProvider does, why it is important, and suggest one concrete source-backed improvement.";

    const rawListFilesResult = [
        "packages/providers/src/compatibility/text-tool-protocol.ts",
        "packages/providers/src/compatibility/text-tool-provider.ts",
        "packages/providers/src/index.ts",
        "packages/providers/src/openai-compatible/openai-compatible-provider.ts",
    ].join("\n");

    const rawSearchResult = [
        "packages/providers/src/compatibility/text-tool-provider.ts:42:export class TextToolCompatibilityProvider implements ModelProvider {",
        "packages/providers/src/index.ts:5:export { TextToolCompatibilityProvider } from './compatibility/text-tool-provider.js';",
    ].join("\n");

    const rawReadFileResult = [
        "export class TextToolCompatibilityProvider implements ModelProvider {",
        "  // Intercepts model stream and parses <akkco_tool_call> envelopes.",
        "  // Buffers potential XML tags to prevent envelope leakage to user.",
        "  // When parsing fails, injects COMPATIBILITY_REPAIR_INSTRUCTION for a 1-turn recovery.",
        "}",
    ].join("\n");

    const finalAnswerText =
        "TextToolCompatibilityProvider wraps any text-only LLM provider to enable reliable tool-calling " +
        "via <akkco_tool_call> XML envelopes. It buffers streaming prose, suppresses raw envelope syntax, " +
        "and handles 1-turn repair recovery. A concrete source-backed improvement is adding support for " +
        "multi-tool calls in a single turn, which is currently restricted by rule 3 of the tool protocol.";

    let turn = 0;
    const capturedRequests: ModelRequest[] = [];

    const provider: ModelProvider = {
        id: "deterministic-realistic-provider",
        stream: (request) => {
            capturedRequests.push(request);
            turn++;

            if (turn === 1) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_real_1",
                        name: "list_files",
                        arguments: { path: "packages/providers/src" },
                    } satisfies ModelEvent;
                })();
            }

            if (turn === 2) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_real_2",
                        name: "search_text",
                        arguments: {
                            query: "TextToolCompatibilityProvider",
                            path: "packages/providers/src",
                        },
                    } satisfies ModelEvent;
                })();
            }

            if (turn === 3) {
                return (async function* () {
                    yield {
                        type: "tool_call",
                        id: "call_real_3",
                        name: "read_file",
                        arguments: {
                            path: "packages/providers/src/compatibility/text-tool-provider.ts",
                        },
                    } satisfies ModelEvent;
                })();
            }

            return (async function* () {
                yield { type: "text", content: finalAnswerText } satisfies ModelEvent;
            })();
        },
    };

    const toolHost: RuntimeToolHost = {
        tools: [
            { name: "list_files", description: "List files", inputSchema: {} },
            { name: "search_text", description: "Search text", inputSchema: {} },
            { name: "read_file", description: "Read file", inputSchema: {} },
        ],
        execute: async (name) => {
            if (name === "list_files") return { content: rawListFilesResult };
            if (name === "search_text") return { content: rawSearchResult };
            if (name === "read_file") return { content: rawReadFileResult };
            return { content: "" };
        },
    };

    const runtime = createAkkcoRuntime(provider, {
        toolHost,
        milestones: true,
    });

    const session = createAkkcoSession(runtime);
    const events: RuntimeEvent[] = [];

    for await (const event of session.send(PROMPT)) {
        events.push(event);
    }

    // 1. Verify 4 provider calls occurred: 3 tool calls + 1 final answer
    assert.equal(capturedRequests.length, 4);

    // 2. Verify model context evolution:
    // Request 1: Only the original goal
    const req1Items = capturedRequests[0].items;
    assert.equal(req1Items.length, 2); // system policy + user prompt
    assert.equal(req1Items[0].type, "message");
    assert.equal(req1Items[0].role, "system");
    assert.equal(req1Items[1].type, "message");
    assert.equal(req1Items[1].role, "user");
    assert.equal((req1Items[1] as ModelMessage).content, PROMPT);

    // Request 2: System policy + Original Goal + Milestone 1 (list_files)
    const req2Items = capturedRequests[1].items;
    assert.equal(req2Items.length, 3);
    assert.equal((req2Items[1] as ModelMessage).content, PROMPT);
    assert.ok(
        (req2Items[2] as ModelMessage).content.includes(
            '[Milestone: list_files (call_id: "call_real_1")',
        ),
    );
    assert.ok(
        (req2Items[2] as ModelMessage).content.includes(
            "packages/providers/src/compatibility/text-tool-provider.ts",
        ),
    );

    // Request 3: System policy + Original Goal + Milestone 1 + Milestone 2 (search_text)
    const req3Items = capturedRequests[2].items;
    assert.equal(req3Items.length, 4);
    assert.equal((req3Items[1] as ModelMessage).content, PROMPT);
    assert.ok(
        (req3Items[2] as ModelMessage).content.includes(
            '[Milestone: list_files (call_id: "call_real_1")',
        ),
    );
    assert.ok(
        (req3Items[3] as ModelMessage).content.includes(
            '[Milestone: search_text (call_id: "call_real_2")',
        ),
    );

    // Request 4: System policy + Original Goal + Milestone 1 + Milestone 2 + Milestone 3 (read_file)
    const req4Items = capturedRequests[3].items;
    assert.equal(req4Items.length, 5);
    assert.equal((req4Items[1] as ModelMessage).content, PROMPT);
    assert.ok(
        (req4Items[2] as ModelMessage).content.includes(
            '[Milestone: list_files (call_id: "call_real_1")',
        ),
    );
    assert.ok(
        (req4Items[3] as ModelMessage).content.includes(
            '[Milestone: search_text (call_id: "call_real_2")',
        ),
    );
    assert.ok(
        (req4Items[4] as ModelMessage).content.includes(
            '[Milestone: read_file (call_id: "call_real_3")',
        ),
    );

    // 3. Verify original evidence remains 100% recoverable from canonical transcript
    const transcript = session.transcript;
    const recovered1 = recoverMilestoneEvidence(transcript, "call_real_1");
    assert.equal(recovered1, rawListFilesResult);

    const recovered2 = recoverMilestoneEvidence(transcript, "call_real_2");
    assert.equal(recovered2, rawSearchResult);

    const recovered3 = recoverMilestoneEvidence(transcript, "call_real_3");
    assert.equal(recovered3, rawReadFileResult);

    // 4. Verify user-facing events delivered
    const toolExecEvents = events.filter((e) => e.type === "tool_execution");
    assert.equal(toolExecEvents.length, 3);
    assert.equal(toolExecEvents[0].status, "completed");
    assert.equal(toolExecEvents[1].status, "completed");
    assert.equal(toolExecEvents[2].status, "completed");

    const textEvents = events.filter((e) => e.type === "text");
    assert.ok(textEvents.length > 0);
    const combinedText = textEvents.map((t: any) => t.content).join("");
    assert.equal(combinedText, finalAnswerText);
});
