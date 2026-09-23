import assert from "node:assert";
import test from "node:test";
import { createAkkcoRuntime } from "../src/index.js";
import type { ModelEvent, ModelProvider, ModelRequest } from "@akkco/models";

test("createAkkcoRuntime delegates ModelRequest with signal directly to provider", async () => {
    let capturedRequest: ModelRequest | undefined;
    const provider: ModelProvider = {
        id: "mock",
        stream: (request: ModelRequest) => {
            capturedRequest = request;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "response" } satisfies ModelEvent;
                },
            };
        },
    };

    const runtime = createAkkcoRuntime(provider);
    const controller = new AbortController();
    const req: ModelRequest = {
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
    };

    const events: ModelEvent[] = [];
    for await (const event of runtime.run(req)) {
        events.push(event);
    }

    assert.strictEqual(capturedRequest, req);
    assert.strictEqual(capturedRequest.signal, controller.signal);
    assert.deepStrictEqual(events, [{ type: "text", content: "response" }]);
});
