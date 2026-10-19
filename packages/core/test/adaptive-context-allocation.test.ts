import assert from "node:assert/strict";
import test from "node:test";
import type { ModelItem, ModelProfile } from "@akkco/models";
import {
    calculateMaxInputTokens,
    ContextBudgetOverflowError,
    createBoundedContextCompiler,
    deriveContextBudget,
    estimateModelItemTokens,
    estimateTokens,
    type TranscriptItem,
} from "../src/index.js";
import type {
    ConversationMemoryCandidate,
    ConversationMemoryRetriever,
} from "../src/memory/memory-retriever.js";

const makeFakeRetriever = (
    candidates: ConversationMemoryCandidate[],
): ConversationMemoryRetriever => ({
    retrieve: async () => candidates,
    embedQuery: async () => null,
});

test("Phase A: calculateMaxInputTokens and deriveContextBudget scale without fixed 1K/2K ceilings across window sizes", () => {
    // Small window (2K)
    const smallProfile: ModelProfile = {
        id: "small-model",
        contextWindowTokens: 2048,
        maxOutputTokens: 512,
        safetyMarginTokens: 128,
        toolMode: "native",
    };
    const smallCap = calculateMaxInputTokens(smallProfile);
    assert.strictEqual(smallCap, 1408);
    const smallBudget = deriveContextBudget(smallProfile);
    assert.strictEqual(smallBudget.preferredInputTokens, 1408);
    assert.strictEqual(smallBudget.minimumRecentHistoryTokens, Math.floor(1408 * 0.25));
    assert.strictEqual(smallBudget.maximumMemoryTokens, Math.floor(1408 * 0.3));
    assert.strictEqual(smallBudget.maximumRepositoryTokens, Math.floor(1408 * 0.3));
    assert.strictEqual(smallBudget.reservedOverheadTokens, 0);

    // 8K window
    const profile8k: ModelProfile = {
        id: "8k-model",
        contextWindowTokens: 8192,
        maxOutputTokens: 1024,
        safetyMarginTokens: 256,
        toolMode: "native",
    };
    const cap8k = calculateMaxInputTokens(profile8k);
    assert.strictEqual(cap8k, 6912);
    const budget8k = deriveContextBudget(profile8k);
    assert.strictEqual(budget8k.preferredInputTokens, 6912);
    assert.strictEqual(budget8k.minimumRecentHistoryTokens, 1728);
    // 2073 exceeds old 2048 clamp!
    assert.strictEqual(budget8k.maximumMemoryTokens, 2073);
    assert.strictEqual(budget8k.maximumRepositoryTokens, 2073);

    // 32K window
    const profile32k: ModelProfile = {
        id: "32k-model",
        contextWindowTokens: 32768,
        maxOutputTokens: 2048,
        safetyMarginTokens: 512,
        toolMode: "native",
    };
    const cap32k = calculateMaxInputTokens(profile32k);
    assert.strictEqual(cap32k, 30208);
    const budget32k = deriveContextBudget(profile32k);
    assert.strictEqual(budget32k.preferredInputTokens, 30208);
    // Vastly exceeds old 1536 and 2048 ceilings
    assert.strictEqual(budget32k.minimumRecentHistoryTokens, 7552);
    assert.strictEqual(budget32k.maximumMemoryTokens, 9062);
    assert.strictEqual(budget32k.maximumRepositoryTokens, 9062);

    // 128K window
    const profile128k: ModelProfile = {
        id: "128k-model",
        contextWindowTokens: 131072,
        maxOutputTokens: 4096,
        safetyMarginTokens: 1024,
        toolMode: "native",
    };
    const cap128k = calculateMaxInputTokens(profile128k);
    assert.strictEqual(cap128k, 125952);
    const budget128k = deriveContextBudget(profile128k);
    assert.strictEqual(budget128k.preferredInputTokens, 125952);
    assert.strictEqual(budget128k.minimumRecentHistoryTokens, 31488);
    assert.strictEqual(budget128k.maximumMemoryTokens, 37785);
    assert.strictEqual(budget128k.maximumRepositoryTokens, 37785);
});

test("Phase A: compiler reclaims unused memory and repository capacity for older conversational history", async () => {
    // 32K window
    const profile: ModelProfile = {
        id: "test-reclaim",
        contextWindowTokens: 32768,
        maxOutputTokens: 2048,
        safetyMarginTokens: 512,
        toolMode: "native",
    };

    // Build 40 substantial turns of history (~250 tokens per turn = ~10,000 tokens total)
    const transcript: TranscriptItem[] = [];
    for (let i = 1; i <= 40; i++) {
        transcript.push({
            type: "user",
            content:
                `Turn ${i}: Question about architectural module separation and context compiling invariants. ` +
                "Detailed query discussion. ".repeat(15),
        });
        transcript.push({
            type: "assistant",
            content:
                `Turn ${i}: Comprehensive architectural explanation regarding token budgets, deterministic request preflight, and model profiles. ` +
                "Detailed response explanation. ".repeat(20),
            status: "completed",
        });
    }
    transcript.push({
        type: "user",
        content: "What did we decide about context compiling in turn 5?",
    });

    // Case 1: Empty memory retriever (0 tokens used by memory)
    // Repository retrieval is not implemented (0 tokens used by repo)
    // Both memory (30%), repo (30%), and flexible (15%) are released and reclaimed!
    const compiler = createBoundedContextCompiler({
        profile,
        memoryRetriever: makeFakeRetriever([]),
    });

    const compiled = await compiler.compile({ transcript });
    const content = compiled.map((it) => (it.type === "message" ? it.content : "")).join(" ");

    // Turn 1 and Turn 5 should be present because the entire 30K capacity reclaimed history
    assert.ok(content.includes("Turn 1:"), "Turn 1 was reclaimed and included");
    assert.ok(content.includes("Turn 5:"), "Turn 5 was reclaimed and included");
    assert.ok(content.includes("Turn 40:"), "Turn 40 was included");

    const totalTokens = compiled.reduce((sum, it) => sum + estimateModelItemTokens(it), 0);
    const maxCapacity = calculateMaxInputTokens(profile);
    assert.ok(totalTokens <= maxCapacity, `Total tokens ${totalTokens} must be <= ${maxCapacity}`);
    // History should consume far more than the initial 25% target (~7500 tokens)
    assert.ok(totalTokens > 7500, `Expected history to reclaim capacity, used ${totalTokens}`);
});

test("Phase A: compiler redistributes capacity to retrieved memory when recent conversation is short", async () => {
    const profile: ModelProfile = {
        id: "test-short-history",
        contextWindowTokens: 16384,
        maxOutputTokens: 1024,
        safetyMarginTokens: 256,
        toolMode: "native",
    };
    const maxCapacity = calculateMaxInputTokens(profile); // 15104

    // Only 1 short prior turn
    const transcript: TranscriptItem[] = [
        { type: "user", content: "Hi" },
        { type: "assistant", content: "Hello", status: "completed" },
        { type: "user", content: "Explain previous decisions" },
    ];

    // Substantial memory candidates (totaling ~10,000 tokens, which is > 30% of 15,104 = ~4,500 tokens)
    const candidates: ConversationMemoryCandidate[] = [];
    for (let i = 1; i <= 25; i++) {
        const content =
            `Important decision ${i}: ` +
            "Detail analysis paragraph explaining system invariants and decisions. ".repeat(25);
        candidates.push({
            document: {
                id: `doc-${i}`,
                sessionId: "other-session",
                startSequence: i * 2,
                endSequence: i * 2 + 1,
                content,
                embeddingProvider: "test",
                embeddingModel: "test",
                embeddingDimensions: 3,
                createdAt: new Date().toISOString(),
            },
            similarity: 0.95 - i * 0.01,
            estimatedTokens: estimateTokens(content),
        });
    }

    const compiler = createBoundedContextCompiler({
        profile,
        memoryRetriever: makeFakeRetriever(candidates),
    });

    const compiled = await compiler.compile({ transcript });
    const memoryItem = compiled.find(
        (it) => it.type === "message" && it.provenance?.source === "memory",
    );
    assert.ok(memoryItem, "Retrieved memory message is present");

    const memoryTokens = estimateModelItemTokens(memoryItem);
    // Since recent conversation is very short, memory successfully consumed excess available capacity
    const initial30Percent = Math.floor((maxCapacity - 100) * 0.3);
    assert.ok(
        memoryTokens > initial30Percent,
        `Memory tokens ${memoryTokens} should expand beyond 30% soft target (${initial30Percent}) when recent conversation is short`,
    );

    const totalTokens = compiled.reduce((sum, it) => sum + estimateModelItemTokens(it), 0);
    assert.ok(totalTokens <= maxCapacity, `Total tokens ${totalTokens} must be <= ${maxCapacity}`);
});

test("Phase A: explicit user-defined hard limits are respected", async () => {
    const profile: ModelProfile = {
        id: "test-hard-limits",
        contextWindowTokens: 32768,
        maxOutputTokens: 2048,
        safetyMarginTokens: 512,
        toolMode: "native",
    };

    const transcript: TranscriptItem[] = [
        { type: "user", content: "Hi" },
        { type: "assistant", content: "Hello", status: "completed" },
        { type: "user", content: "Recall everything" },
    ];

    const candidates: ConversationMemoryCandidate[] = [];
    for (let i = 1; i <= 10; i++) {
        const content = `Decision ${i}: ` + "Memory payload data text. ".repeat(40);
        candidates.push({
            document: {
                id: `doc-${i}`,
                sessionId: "other-session",
                startSequence: i * 2,
                endSequence: i * 2 + 1,
                content,
                embeddingProvider: "test",
                embeddingModel: "test",
                embeddingDimensions: 3,
                createdAt: new Date().toISOString(),
            },
            similarity: 0.9,
            estimatedTokens: estimateTokens(content),
        });
    }

    // User specifies explicit hard limit: maximumMemoryTokens = 600
    const explicitBudget = deriveContextBudget(profile, {
        maximumMemoryTokens: 600,
    });
    assert.strictEqual(explicitBudget.maximumMemoryTokens, 600);

    const compiler = createBoundedContextCompiler({
        budget: explicitBudget,
        profile,
        memoryRetriever: makeFakeRetriever(candidates),
    });

    const compiled = await compiler.compile({ transcript });
    const memoryItem = compiled.find(
        (it) => it.type === "message" && it.provenance?.source === "memory",
    );
    assert.ok(memoryItem);
    const memoryTokens = estimateModelItemTokens(memoryItem);
    assert.ok(
        memoryTokens <= 600,
        `Memory tokens ${memoryTokens} must not exceed explicit hard limit 600`,
    );
});

test("Phase A: oversized mandatory system policy or user prompt throws ContextBudgetOverflowError", async () => {
    const smallProfile: ModelProfile = {
        id: "tiny-model",
        contextWindowTokens: 500,
        maxOutputTokens: 200,
        safetyMarginTokens: 50,
        toolMode: "native",
    };
    // Input cap = 250 tokens

    const compiler = createBoundedContextCompiler({
        profile: smallProfile,
    });

    const hugePrompt = "Huge prompt text. ".repeat(100); // 1800 chars ~ 450 tokens > 250 capacity
    const transcript: TranscriptItem[] = [{ type: "user", content: hugePrompt }];

    await assert.rejects(
        async () => {
            await compiler.compile({ transcript });
        },
        (err: unknown) => {
            assert.ok(err instanceof ContextBudgetOverflowError);
            assert.ok(err.message.includes("exceed available token budget"));
            return true;
        },
    );
});

test("Phase A: backward compatibility with legacy budget callers without profile", async () => {
    // Caller provides legacy budget without profile
    const compiler = createBoundedContextCompiler({
        budget: {
            preferredInputTokens: 1000,
            reservedOverheadTokens: 100,
            minimumRecentHistoryTokens: 200,
            maximumMemoryTokens: 300,
        },
    });

    const transcript: TranscriptItem[] = [
        { type: "user", content: "Question 1" },
        { type: "assistant", content: "Answer 1", status: "completed" },
        { type: "user", content: "Question 2" },
    ];

    const compiled = await compiler.compile({ transcript });
    assert.ok(compiled.length >= 3);
    assert.strictEqual(compiled.at(-1)?.type, "message");
    assert.strictEqual((compiled.at(-1) as any).content, "Question 2");
});
