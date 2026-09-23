import assert from "node:assert";
import test from "node:test";
import { createAkkcoRuntime, createAkkcoSession, Session } from "../src/index.js";
import type { ModelEvent, ModelProvider, ModelRequest } from "@akkco/models";

test("User message is committed only when generation begins, not at send()", async () => {
    let runtimeCalled = false;
    const provider: ModelProvider = {
        id: "test",
        stream: () => {
            runtimeCalled = true;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "hi" } satisfies ModelEvent;
                },
            };
        },
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);

    const stream = session.send("hello");
    // Not consumed yet -> history must remain untouched
    assert.strictEqual(session.messages.length, 0);
    assert.strictEqual(runtimeCalled, false);

    const iterator = stream[Symbol.asyncIterator]();
    // Before next() is called, generator body has not run
    assert.strictEqual(session.messages.length, 0);

    // When next() is called, generator begins and commits user message before runtime execution
    const first = await iterator.next();
    assert.strictEqual(session.messages.length, 1);
    assert.deepStrictEqual(session.messages[0], { role: "user", content: "hello" });
    assert.strictEqual(first.value?.content, "hi");

    let res = await iterator.next();
    while (!res.done) {
        res = await iterator.next();
    }
});

test("Complete assistant message is committed only on successful completion", async () => {
    const provider: ModelProvider = {
        id: "test",
        stream: () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "Hello " } satisfies ModelEvent;
                yield { type: "text", content: "world!" } satisfies ModelEvent;
            },
        }),
    };
    const runtime = createAkkcoRuntime(provider);
    const session = createAkkcoSession(runtime);

    const received: string[] = [];
    for await (const event of session.send("greet")) {
        received.push(event.content);
        // During streaming, assistant message is not committed yet
        assert.strictEqual(session.messages.length, 1);
    }

    assert.deepStrictEqual(received, ["Hello ", "world!"]);
    // Committed upon complete iteration
    assert.strictEqual(session.messages.length, 2);
    assert.deepStrictEqual(session.messages[0], { role: "user", content: "greet" });
    assert.deepStrictEqual(session.messages[1], { role: "assistant", content: "Hello world!" });
});

test("Partial assistant response is not committed on cancellation or error", async () => {
    const provider: ModelProvider = {
        id: "test",
        stream: (request: ModelRequest) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "chunk 1 " } satisfies ModelEvent;
                yield { type: "text", content: "chunk 2 " } satisfies ModelEvent;
                if (request.signal?.aborted) {
                    throw new Error("Aborted");
                }
                throw new Error("Network failure mid-stream");
            },
        }),
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);

    const chunks: string[] = [];
    await assert.rejects(async () => {
        for await (const event of session.send("prompt")) {
            chunks.push(event.content);
        }
    }, /Network failure mid-stream/);

    assert.deepStrictEqual(chunks, ["chunk 1 ", "chunk 2 "]);
    // Assistant message must NOT be committed
    assert.strictEqual(session.messages.length, 1);
    assert.deepStrictEqual(session.messages[0], { role: "user", content: "prompt" });
    assert.strictEqual(session.isRunning, false);
});

test("Partial assistant response is not committed when consumer breaks early", async () => {
    const provider: ModelProvider = {
        id: "test",
        stream: () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "token 1" } satisfies ModelEvent;
                yield { type: "text", content: "token 2" } satisfies ModelEvent;
                yield { type: "text", content: "token 3" } satisfies ModelEvent;
            },
        }),
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);

    for await (const event of session.send("early break")) {
        if (event.content === "token 1") {
            break;
        }
    }

    assert.strictEqual(session.isRunning, false);
    assert.strictEqual(session.messages.length, 1);
    assert.deepStrictEqual(session.messages[0], { role: "user", content: "early break" });
});

test("In-flight lock: only one generation actively running per Session", async () => {
    let unblockFirst: () => void;
    const provider: ModelProvider = {
        id: "test",
        stream: () => ({
            async *[Symbol.asyncIterator]() {
                const waitPromise = new Promise<void>((resolve) => {
                    unblockFirst = resolve;
                });
                yield { type: "text", content: "running" } satisfies ModelEvent;
                await waitPromise;
                yield { type: "text", content: " done" } satisfies ModelEvent;
            },
        }),
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);

    const stream1 = session.send("first");
    const stream2 = session.send("second");

    const it1 = stream1[Symbol.asyncIterator]();
    const firstYield = await it1.next();
    assert.strictEqual(firstYield.value?.content, "running");
    assert.strictEqual(session.isRunning, true);

    // Consuming stream2 while stream1 is in-flight must fail immediately
    await assert.rejects(async () => {
        for await (const _ of stream2) {}
    }, /A generation is already in progress for this session/);

    // Stream 2 attempt did not alter session history
    assert.strictEqual(session.messages.length, 1);
    assert.deepStrictEqual(session.messages[0], { role: "user", content: "first" });

    // Complete stream 1
    unblockFirst!();
    let res = await it1.next();
    while (!res.done) {
        res = await it1.next();
    }

    assert.strictEqual(session.isRunning, false);
    assert.strictEqual(session.messages.length, 2);
    assert.deepStrictEqual(session.messages[1], { role: "assistant", content: "running done" });
});

test("Lock is always released even when runtime.run throws synchronously", async () => {
    const runtime = {
        run: () => {
            throw new Error("Immediate synchronous failure");
        },
    };
    const session = new Session(runtime);

    await assert.rejects(async () => {
        for await (const _ of session.send("boom")) {}
    }, /Immediate synchronous failure/);

    assert.strictEqual(session.isRunning, false);
    assert.strictEqual(session.messages.length, 1);
});

test("History snapshots are isolated across turns", async () => {
    const recordedRequests: ModelRequest[] = [];
    const provider: ModelProvider = {
        id: "test",
        stream: (request: ModelRequest) => {
            recordedRequests.push(request);
            const index = recordedRequests.length;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: `reply ${index}` } satisfies ModelEvent;
                },
            };
        },
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);

    for await (const _ of session.send("turn 1")) {}
    for await (const _ of session.send("turn 2")) {}

    assert.strictEqual(recordedRequests.length, 2);
    assert.deepStrictEqual(recordedRequests[0].messages, [
        { role: "user", content: "turn 1" },
    ]);
    assert.deepStrictEqual(recordedRequests[1].messages, [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "turn 2" },
    ]);
});

test("External callers cannot mutate internal history", async () => {
    const fakeRuntime = {
        run: (_request: ModelRequest) => ({
            async *[Symbol.asyncIterator]() {},
        }),
    };
    const session = new Session(fakeRuntime);
    session.send("immutable");

    // Consume to commit user message and assistant message
    for await (const _ of session.send("test")) {}
    assert.strictEqual(session.messages.length, 2);

    const snapshot = session.messages;
    (snapshot as any).push({ role: "assistant", content: "injected" });
    assert.strictEqual(session.messages.length, 2);

    snapshot[0].content = "tampered";
    assert.strictEqual(session.messages[0].content, "test");
});

test("clear() empties conversation history", async () => {
    const provider: ModelProvider = {
        id: "test",
        stream: () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "answer" } satisfies ModelEvent;
            },
        }),
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);

    for await (const _ of session.send("msg")) {}
    assert.strictEqual(session.messages.length, 2);

    session.clear();
    assert.strictEqual(session.messages.length, 0);
    assert.deepStrictEqual(session.messages, []);
});
