import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicFakeEmbeddingProvider } from "../src/testing/index.js";

test("DeterministicFakeEmbeddingProvider: identical inputs produce identical vectors", async () => {
    const provider = new DeterministicFakeEmbeddingProvider({ dimensions: 8 });
    const [vec1] = await provider.embed(["hello world"]);
    const [vec2] = await provider.embed(["hello world"]);

    assert.equal(vec1.length, 8);
    assert.deepEqual(vec1, vec2);
});

test("DeterministicFakeEmbeddingProvider: batch ordering is strictly preserved", async () => {
    const provider = new DeterministicFakeEmbeddingProvider({ dimensions: 8 });
    const inputs = ["apple", "banana", "cherry", "date"];
    const results = await provider.embed(inputs);

    assert.equal(results.length, 4);

    for (let i = 0; i < inputs.length; i++) {
        const [single] = await provider.embed([inputs[i]]);
        assert.deepEqual(results[i], single);
    }
});

test("DeterministicFakeEmbeddingProvider: vectors contain finite numbers and consistent dimensions", async () => {
    const provider = new DeterministicFakeEmbeddingProvider({ dimensions: 12 });
    const results = await provider.embed([
        "test 1",
        "test 2",
        "",
        "longer text with lots of characters",
    ]);

    assert.equal(results.length, 4);
    for (const vec of results) {
        assert.equal(vec.length, 12);
        for (const val of vec) {
            assert.equal(typeof val, "number");
            assert.ok(Number.isFinite(val));
        }
    }
});

test("DeterministicFakeEmbeddingProvider: supports AbortSignal cancellation", async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        async () => {
            await provider.embed(["hello"], controller.signal);
        },
        { name: "AbortError" },
    );
});

test("DeterministicFakeEmbeddingProvider: custom vectors and semantic rules work predictably", async () => {
    const targetVec = [1, 0, 0, 0];
    const provider = new DeterministicFakeEmbeddingProvider({
        dimensions: 4,
        customVectors: {
            exact: targetVec,
        },
        semanticRules: [
            {
                pattern: /decision/i,
                vector: [0, 1, 0, 0],
            },
        ],
    });

    const [exactRes] = await provider.embed(["exact"]);
    assert.deepEqual(exactRes, targetVec);

    const [ruleRes] = await provider.embed(["Important architectural decision recorded"]);
    assert.deepEqual(ruleRes, [0, 1, 0, 0]);
});

test("DeterministicFakeEmbeddingProvider: exposes embedding identity", () => {
    const provider = new DeterministicFakeEmbeddingProvider({
        id: "test-fake",
        model: "fake-v1",
        dimensions: 32,
    });

    assert.equal(provider.id, "test-fake");
    assert.equal(provider.model, "fake-v1");
    assert.equal(provider.dimensions, 32);
});
