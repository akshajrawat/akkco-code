import assert from "node:assert/strict";
import test from "node:test";
import { cosineSimilarity } from "../src/sqlite/cosine.js";
import { deserializeVector, serializeVector } from "../src/sqlite/vector-serializer.js";

test("vectorSerializer: serializes and deserializes Float32Array accurately", () => {
    const original = [0.12345, -0.6789, 1.0, 0.0, 99.5];
    const serialized = serializeVector(original);

    assert.ok(serialized instanceof Uint8Array);
    assert.equal(serialized.byteLength, original.length * 4);

    const deserialized = deserializeVector(serialized, original.length);
    assert.equal(deserialized.length, original.length);

    for (let i = 0; i < original.length; i++) {
        assert.ok(Math.abs(deserialized[i] - original[i]) < 1e-5);
    }
});

test("vectorSerializer: rejects empty vector", () => {
    assert.throws(() => serializeVector([]), { message: /Cannot serialize empty vector/ });
    assert.throws(() => deserializeVector(new Uint8Array(0)), {
        message: /Cannot deserialize empty vector blob/,
    });
});

test("vectorSerializer: rejects non-finite values", () => {
    assert.throws(() => serializeVector([1.0, NaN, 3.0]), {
        message: /non-finite value/,
    });
    assert.throws(() => serializeVector([1.0, Infinity, 3.0]), {
        message: /non-finite value/,
    });
});

test("vectorSerializer: detects dimension mismatch and malformed byte length", () => {
    const serialized = serializeVector([1.0, 2.0, 3.0]); // 12 bytes = 3 floats

    // Dimension mismatch
    assert.throws(() => deserializeVector(serialized, 4), {
        message: /Vector dimension mismatch: expected 4, got 3/,
    });

    // Malformed byte length (not divisible by 4)
    const malformed = new Uint8Array([1, 2, 3]);
    assert.throws(() => deserializeVector(malformed), {
        message: /not a multiple of 4/,
    });
});

test("cosineSimilarity: computes cosine similarity correctly", () => {
    // Identical normalized vectors -> similarity 1
    const vec1 = [1, 0, 0];
    const vec2 = [1, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(vec1, vec2) - 1.0) < 1e-6);

    // Orthogonal vectors -> similarity 0
    const vecOrthogonal = [0, 1, 0];
    assert.equal(cosineSimilarity(vec1, vecOrthogonal), 0);

    // Opposite vectors -> similarity -1
    const vecOpposite = [-1, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(vec1, vecOpposite) - -1.0) < 1e-6);

    // Empty or mismatched lengths -> 0
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity([1, 2], [1]), 0);
});
