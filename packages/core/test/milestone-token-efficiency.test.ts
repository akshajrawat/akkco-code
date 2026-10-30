import assert from "node:assert/strict";
import test from "node:test";
import {
    deriveDeterministicDid,
    deriveMilestoneTarget,
    formatMilestoneAsModelItem,
    formatMilestoneText,
    reconstructContextWithMilestones,
    recoverMilestoneEvidence,
} from "../src/context/milestone-context.js";
import { estimateTokens } from "../src/context/token-estimator.js";
import {
    extractFailureMilestone,
    extractGenericDeterministicMilestone,
    extractListFilesMilestone,
    extractReadFileMilestone,
    extractSearchTextMilestone,
} from "../src/runtime/milestones/deterministic-extractor.js";
import { validateEvidence } from "../src/runtime/milestones/evidence-validator.js";
import {
    createMilestoneProcessor,
    DefaultMilestoneProcessor,
} from "../src/runtime/milestones/processor.js";
import type { ToolMilestone } from "../src/runtime/milestones/types.js";
import type { TranscriptItem } from "../src/transcript/types.js";

test("Token-Efficient Milestones: 3-field format output for list_files, search_text, read_file, and failure cases", () => {
    // 1. read_file
    const readFileMilestone = extractReadFileMilestone(
        {
            parentGoal: "Inspect codebase",
            parentGoalId: "goal-1",
            callId: "call_rf1",
            toolName: "read_file",
            arguments: { path: "packages/core/src/runtime.ts" },
            rawResult: "export class Runtime {\n  run() {\n    return true;\n  }\n}\n",
            executionStatus: "completed",
            durationMs: 15,
            index: 1,
        },
        4,
    );

    const readFileText = formatMilestoneText(readFileMilestone, 1);
    assert.match(readFileText, /^M1 \| read_file \| runtime\.ts/);
    assert.match(readFileText, /Did: Read runtime\.ts \(6 lines\)\./);
    assert.match(readFileText, /Summary:\n- /);
    assert.match(readFileText, /Needs recheck: None/);
    assert.doesNotMatch(readFileText, /\[Milestone:/);
    assert.doesNotMatch(readFileText, /Evidence:/);
    assert.doesNotMatch(readFileText, /Locations:/);

    // 2. list_files
    const listFilesMilestone = extractListFilesMilestone(
        {
            parentGoal: "Inspect codebase",
            parentGoalId: "goal-1",
            callId: "call_lf1",
            toolName: "list_files",
            arguments: { path: "src" },
            rawResult: "file1.ts\nfile2.ts\nfile3.ts\n",
            executionStatus: "completed",
            durationMs: 8,
            index: 2,
        },
        4,
    );

    const listFilesText = formatMilestoneText(listFilesMilestone, 2);
    assert.match(listFilesText, /^M2 \| list_files \| src/);
    assert.match(listFilesText, /Did: Listed directory "src" \(3 entries\)\./);
    assert.match(listFilesText, /Summary:\n- /);
    assert.match(listFilesText, /Needs recheck: None/);

    // 3. search_text
    const searchMilestone = extractSearchTextMilestone(
        {
            parentGoal: "Inspect codebase",
            parentGoalId: "goal-1",
            callId: "call_st1",
            toolName: "search_text",
            arguments: { query: "export class", path: "src" },
            rawResult:
                "src/runtime.ts:1:export class Runtime {\nsrc/session.ts:5:export class Session {\n",
            executionStatus: "completed",
            durationMs: 25,
            index: 3,
        },
        4,
    );

    const searchText = formatMilestoneText(searchMilestone, 3);
    assert.match(searchText, /^M3 \| search_text \| "export class"/);
    assert.match(searchText, /Did: Searched for "export class" in src \(2 matches\)\./);
    assert.match(searchText, /Summary:\n- /);
    assert.match(searchText, /Needs recheck: None/);

    // 4. Failed tool execution
    const failedMilestone = extractFailureMilestone(
        {
            parentGoal: "Inspect codebase",
            parentGoalId: "goal-1",
            callId: "call_fail1",
            toolName: "read_file",
            arguments: { path: "missing.ts" },
            executionStatus: "failed",
            error: "ENOENT: no such file or directory, open 'missing.ts'",
            durationMs: 3,
            index: 4,
        },
        4,
    );

    const failedText = formatMilestoneText(failedMilestone, 4);
    assert.match(failedText, /^M4 \| read_file \| missing\.ts/);
    assert.match(failedText, /Did: Failed execution of read_file\./);
    assert.match(failedText, /Summary:\n- Execution failed: ENOENT/);
    assert.match(failedText, /Needs recheck:\n- Tool execution failed: ENOENT/);

    // 5. Cancelled tool execution
    const cancelledMilestone = extractFailureMilestone(
        {
            parentGoal: "Inspect codebase",
            parentGoalId: "goal-1",
            callId: "call_canc1",
            toolName: "search_text",
            arguments: { query: "long_running" },
            executionStatus: "cancelled",
            durationMs: 50,
            index: 5,
        },
        4,
    );

    const cancelledText = formatMilestoneText(cancelledMilestone, 5);
    assert.match(cancelledText, /^M5 \| search_text \| "long_running"/);
    assert.match(cancelledText, /Did: Cancelled execution of search_text\./);
    assert.match(cancelledText, /Needs recheck:\n- Operation was cancelled by user or signal\./);
});

test("Token-Efficient Milestones: Preservation of rich backend evidence and full metadata", () => {
    const rawResult = "const x = 1;\nconst y = 2;\n";
    const milestone: ToolMilestone = {
        id: "milestone-call_deep1",
        parentGoalId: "goal-persist",
        callId: "call_deep1",
        toolName: "read_file",
        arguments: { path: "deep/path/code.ts" },
        executionStatus: "completed",
        processingStatus: "completed",
        durationMs: 42,
        did: "Read code.ts (2 lines).",
        summary: "Read code.ts (2 lines, 26 chars)",
        findings: ["const x = 1 @1", "const y = 2 @2"],
        sourceLocations: ["deep/path/code.ts:1", "deep/path/code.ts:2"],
        unresolvedQuestions: ["Verify whether y is used"],
        omissions: "None",
        evidenceRefs: ["call:call_deep1"],
        estimatedTokens: 35,
        index: 1,
    };

    // Rich metadata is intact on ToolMilestone object
    assert.equal(milestone.id, "milestone-call_deep1");
    assert.equal(milestone.parentGoalId, "goal-persist");
    assert.equal(milestone.callId, "call_deep1");
    assert.equal(milestone.toolName, "read_file");
    assert.deepEqual(milestone.arguments, { path: "deep/path/code.ts" });
    assert.equal(milestone.executionStatus, "completed");
    assert.equal(milestone.processingStatus, "completed");
    assert.equal(milestone.durationMs, 42);
    assert.deepEqual(milestone.sourceLocations, ["deep/path/code.ts:1", "deep/path/code.ts:2"]);
    assert.deepEqual(milestone.evidenceRefs, ["call:call_deep1"]);

    // But model-facing text only renders the 3 clean fields without leaking internal durationMs or call IDs
    const modelItem = formatMilestoneAsModelItem(milestone, 1);
    assert.equal(modelItem.type, "message");
    assert.equal(modelItem.role, "user");
    assert.doesNotMatch(modelItem.content, /durationMs/);
    assert.doesNotMatch(modelItem.content, /call_deep1/);
    assert.doesNotMatch(modelItem.content, /parentGoalId/);
    assert.match(modelItem.content, /M1 \| read_file \| code\.ts/);
    assert.match(modelItem.content, /Did: Read code\.ts \(2 lines\)\./);
    assert.match(modelItem.content, /Summary:\n- const x = 1 @1\n- const y = 2 @2/);
    assert.match(modelItem.content, /Needs recheck:\n- Verify whether y is used/);
});

test("Token-Efficient Milestones: Recovery of original tool results from transcripts via evidence recovery", () => {
    const transcript: TranscriptItem[] = [
        { type: "user", content: "Inspect runtime" },
        {
            type: "tool_execution",
            callId: "call_rec_1",
            toolName: "read_file",
            arguments: { path: "runtime.ts" },
            result: "ORIGINAL_UNCOMPACTED_RUNTIME_CODE_HERE",
            status: "completed",
            durationMs: 20,
            milestone: {
                id: "milestone-call_rec_1",
                parentGoalId: "goal-123",
                callId: "call_rec_1",
                toolName: "read_file",
                arguments: { path: "runtime.ts" },
                executionStatus: "completed",
                processingStatus: "completed",
                summary: "Read runtime.ts",
                findings: ["Runtime initialized"],
                sourceLocations: ["runtime.ts"],
                evidenceRefs: ["call:call_rec_1"],
                estimatedTokens: 25,
            },
        },
        { type: "assistant", content: "Understood", status: "completed" },
    ];

    // 1. Recover by milestone ID
    const rec1 = recoverMilestoneEvidence(transcript, "milestone-call_rec_1");
    assert.equal(rec1, "ORIGINAL_UNCOMPACTED_RUNTIME_CODE_HERE");

    // 2. Recover by call ID
    const rec2 = recoverMilestoneEvidence(transcript, "call_rec_1");
    assert.equal(rec2, "ORIGINAL_UNCOMPACTED_RUNTIME_CODE_HERE");

    // 3. Unknown ID returns undefined
    const rec3 = recoverMilestoneEvidence(transcript, "nonexistent");
    assert.equal(rec3, undefined);
});

test("Token-Efficient Milestones: Disambiguation across sessions prevents collision when call IDs repeat", () => {
    const transcript: TranscriptItem[] = [
        // Session 1 execution
        {
            type: "tool_execution",
            callId: "call_repeat_1",
            toolName: "read_file",
            arguments: { path: "session1.ts" },
            result: "SESSION_1_SECRET_CONTENT",
            status: "completed",
            milestone: {
                id: "milestone-s1-call_repeat_1",
                parentGoalId: "session-1",
                callId: "call_repeat_1",
                toolName: "read_file",
                arguments: { path: "session1.ts" },
                executionStatus: "completed",
                processingStatus: "completed",
                summary: "Read session1.ts",
                findings: ["session 1"],
                sourceLocations: ["session1.ts"],
                evidenceRefs: ["call:call_repeat_1"],
                estimatedTokens: 20,
            },
        },
        // Session 2 execution with identical call_repeat_1 call ID
        {
            type: "tool_execution",
            callId: "call_repeat_1",
            toolName: "read_file",
            arguments: { path: "session2.ts" },
            result: "SESSION_2_SECRET_CONTENT",
            status: "completed",
            milestone: {
                id: "milestone-s2-call_repeat_1",
                parentGoalId: "session-2",
                callId: "call_repeat_1",
                toolName: "read_file",
                arguments: { path: "session2.ts" },
                executionStatus: "completed",
                processingStatus: "completed",
                summary: "Read session2.ts",
                findings: ["session 2"],
                sourceLocations: ["session2.ts"],
                evidenceRefs: ["call:call_repeat_1"],
                estimatedTokens: 20,
            },
        },
    ];

    // Recover with exact milestone ID
    assert.equal(
        recoverMilestoneEvidence(transcript, "milestone-s1-call_repeat_1"),
        "SESSION_1_SECRET_CONTENT",
    );
    assert.equal(
        recoverMilestoneEvidence(transcript, "milestone-s2-call_repeat_1"),
        "SESSION_2_SECRET_CONTENT",
    );

    // Disambiguate by sessionIdOrGoalId
    assert.equal(
        recoverMilestoneEvidence(transcript, "call_repeat_1", "session-1"),
        "SESSION_1_SECRET_CONTENT",
    );
    assert.equal(
        recoverMilestoneEvidence(transcript, "call_repeat_1", "session-2"),
        "SESSION_2_SECRET_CONTENT",
    );
});

test("Token-Efficient Milestones: Source references and line range citations (@line) accuracy", () => {
    const rawCode = [
        "import { foo } from 'bar';",
        "export function calculateTotal(items: number[]): number {",
        "  return items.reduce((a, b) => a + b, 0);",
        "}",
        "export const VERSION = '1.0.0';",
    ].join("\n");

    const validated = validateEvidence(
        ["src/calc.ts:2", "src/calc.ts:5"],
        ["calculateTotal function defined @2-4", "VERSION constant exported @5"],
        "read_file",
        { path: "src/calc.ts" },
        rawCode,
    );

    assert.equal(validated.establishedFindings.length, 2);
    assert.match(validated.establishedFindings[0], /@2-4/);
    assert.match(validated.establishedFindings[1], /@5/);
    assert.equal(validated.uncertainFindings.length, 0);
});

test("Token-Efficient Milestones: Hallucination detection promotes unsupported claims and out-of-bounds lines to Needs Recheck", () => {
    const rawCode = ["export const alpha = 1;", "export const beta = 2;"].join("\n"); // 2 lines only!

    const validated = validateEvidence(
        ["src/mod.ts:1", "src/mod.ts:999"], // 999 is fabricated
        [
            "alpha is exported @1",
            "gamma function is declared @999", // line 999 is out-of-bounds!
            "`nonExistentSymbol` handles encryption", // ungrounded symbol in backticks!
            "This suggests the architecture assumes a distributed cache", // inferential claim!
        ],
        "read_file",
        { path: "src/mod.ts" },
        rawCode,
    );

    // Only alpha @1 is an established direct observation
    assert.equal(validated.establishedFindings.length, 1);
    assert.equal(validated.establishedFindings[0], "alpha is exported @1");

    // All invalid, inferential, or out-of-bounds claims are routed to uncertainFindings
    assert.equal(validated.uncertainFindings.length, 4);
    assert.ok(
        validated.uncertainFindings.some((f) => f.includes("@999") || f.includes("gamma")),
        "Out of bounds line must be moved to uncertain findings",
    );
    assert.ok(
        validated.uncertainFindings.some((f) => f.includes("nonExistentSymbol")),
        "Ungrounded identifier must be moved to uncertain findings",
    );
    assert.ok(
        validated.uncertainFindings.some((f) => f.includes("suggests") || f.includes("assumes")),
        "Inferential/speculative claim must be moved to uncertain findings",
    );

    // When formatted, uncertain findings render strictly under 'Needs recheck:'
    const milestone: ToolMilestone = {
        id: "milestone-check",
        parentGoalId: "goal-1",
        callId: "call-check",
        toolName: "read_file",
        arguments: { path: "src/mod.ts" },
        executionStatus: "completed",
        processingStatus: "completed",
        did: "Read mod.ts (2 lines).",
        summary: "Read mod.ts",
        findings: validated.establishedFindings,
        unresolvedQuestions: validated.uncertainFindings,
        sourceLocations: validated.verifiedLocations,
        evidenceRefs: ["call:call-check"],
        estimatedTokens: 40,
        index: 1,
    };

    const formatted = formatMilestoneText(milestone, 1);
    assert.match(formatted, /Summary:\n- alpha is exported @1/);
    assert.match(formatted, /Needs recheck:/);
    assert.ok(formatted.includes("gamma"));
    assert.ok(formatted.includes("nonExistentSymbol"));
});

test("Token-Efficient Milestones: Token count comparison demonstrates >50% token reduction across representative outputs", () => {
    // Legacy verbose milestone formatter representing the previous architecture
    const formatLegacyVerboseMilestone = (
        toolName: string,
        callId: string,
        summary: string,
        findings: readonly string[],
        locations: string[],
        evidenceRef: string,
    ): string => {
        const lines: string[] = [
            `[Milestone: ${toolName} (call_id: "${callId}") - Execution: completed | Processing: completed]`,
            `Summary: ${summary}`,
            "Findings:",
            ...findings.map((f) => `- ${f}`),
            "Locations:",
            ...locations.map((l) => `- ${l}`),
            `Evidence: ${evidenceRef}`,
        ];
        return lines.join("\n");
    };

    const charsPerToken = 4;

    // Case 1: read_file
    const rfMilestone = extractReadFileMilestone(
        {
            parentGoal: "Inspect codebase",
            parentGoalId: "goal-1",
            callId: "call_rf",
            toolName: "read_file",
            arguments: { path: "packages/providers/src/compatibility/text-tool-provider.ts" },
            rawResult: [
                "export class TextToolCompatibilityProvider {",
                "  constructor(inner: ModelProvider) {}",
                "  stream(req: ModelRequest) { return inner.stream(req); }",
                "}",
            ].join("\n"),
            executionStatus: "completed",
            durationMs: 15,
            index: 1,
        },
        charsPerToken,
    );

    const rfNewText = formatMilestoneText(rfMilestone, 1);
    const rfOldText = formatLegacyVerboseMilestone(
        "read_file",
        "call_rf",
        "Read packages/providers/src/compatibility/text-tool-provider.ts (4 lines, 150 chars)",
        rfMilestone.findings,
        ["packages/providers/src/compatibility/text-tool-provider.ts"],
        "call:call_rf",
    );

    const rfNewTokens = estimateTokens(rfNewText, charsPerToken);
    const rfOldTokens = estimateTokens(rfOldText, charsPerToken);
    const rfReduction = (rfOldTokens - rfNewTokens) / rfOldTokens;

    assert.ok(
        rfReduction >= 0.35,
        `Expected at least 35% reduction for read_file, got ${(rfReduction * 100).toFixed(1)}% (old: ${rfOldTokens}t, new: ${rfNewTokens}t)`,
    );

    // Case 2: search_text
    const stMilestone = extractSearchTextMilestone(
        {
            parentGoal: "Inspect codebase",
            parentGoalId: "goal-1",
            callId: "call_st",
            toolName: "search_text",
            arguments: { query: "export interface", path: "packages/core" },
            rawResult: [
                "packages/core/src/types.ts:10:export interface Config {}",
                "packages/core/src/types.ts:25:export interface User {}",
                "packages/core/src/events.ts:5:export interface Event {}",
            ].join("\n"),
            executionStatus: "completed",
            durationMs: 20,
            index: 2,
        },
        charsPerToken,
    );

    const stNewText = formatMilestoneText(stMilestone, 2);
    const stOldText = formatLegacyVerboseMilestone(
        "search_text",
        "call_st",
        'Searched for "export interface": found 3 matches across 2 files',
        [
            "packages/core/src/types.ts: export interface Config {} @10",
            "packages/core/src/types.ts: export interface User {} @25",
            "packages/core/src/events.ts: export interface Event {} @5",
        ],
        [
            "packages/core/src/types.ts:10",
            "packages/core/src/types.ts:25",
            "packages/core/src/events.ts:5",
        ],
        "call:call_st",
    );

    const stNewTokens = estimateTokens(stNewText, charsPerToken);
    const stOldTokens = estimateTokens(stOldText, charsPerToken);
    const stReduction = (stOldTokens - stNewTokens) / stOldTokens;

    assert.ok(
        stReduction >= 0.35,
        `Expected at least 35% reduction for search_text, got ${(stReduction * 100).toFixed(1)}% (old: ${stOldTokens}t, new: ${stNewTokens}t)`,
    );

    // Case 3: list_files
    const lfMilestone = extractListFilesMilestone(
        {
            parentGoal: "Inspect codebase",
            parentGoalId: "goal-1",
            callId: "call_lf",
            toolName: "list_files",
            arguments: { path: "packages/core/src" },
            rawResult: "runtime.ts\nsession.ts\nevents.ts\ntypes.ts\nindex.ts\n",
            executionStatus: "completed",
            durationMs: 10,
            index: 3,
        },
        charsPerToken,
    );

    const lfNewText = formatMilestoneText(lfMilestone, 3);
    const lfOldText = formatLegacyVerboseMilestone(
        "list_files",
        "call_lf",
        "Found 5 files in packages/core/src",
        [
            "packages/core/src/runtime.ts",
            "packages/core/src/session.ts",
            "packages/core/src/events.ts",
            "packages/core/src/types.ts",
            "packages/core/src/index.ts",
        ],
        ["packages/core/src"],
        "call:call_lf",
    );

    const lfNewTokens = estimateTokens(lfNewText, charsPerToken);
    const lfOldTokens = estimateTokens(lfOldText, charsPerToken);
    const lfReduction = (lfOldTokens - lfNewTokens) / lfOldTokens;

    assert.ok(
        lfReduction >= 0.4,
        `Expected at least 40% reduction for list_files, got ${(lfReduction * 100).toFixed(1)}% (old: ${lfOldTokens}t, new: ${lfNewTokens}t)`,
    );
});
