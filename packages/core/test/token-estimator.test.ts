import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "../src/index.js";

test("estimateTokens: returns ceil(characters / 4)", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a"), 1);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(estimateTokens("12345678"), 2);
    assert.equal(estimateTokens("123456789"), 3);
});
