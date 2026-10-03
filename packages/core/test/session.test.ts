import assert from "node:assert";
import test from "node:test";
import { createAkkcoRuntime, createAkkcoSession, Session } from "../src/index.js";
import type { ModelEvent, ModelProvider, ModelRequest } from "@akkco/models";

test("send() without iteration does not mutate transcript", () => {
    const runtime = { run: () => ({ async *[Symbol.asyncIterator]() {} }) };
    const session = new Session(runtime);

    const stream = session.send("hello");
    assert.ok(stream);
    assert.strictEqual(session.transcript.length, 0);
});

test("generation start commits user transcript item", async () => {
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
    assert.strictEqual(session.transcript.length, 0);
    assert.strictEqual(runtimeCalled, false);

    const iterator = stream[Symbol.asyncIterator]();
    assert.strictEqual(session.transcript.length, 0);

    const first = await iterator.next();
    assert.strictEqual(session.transcript.length, 1);
    assert.deepStrictEqual(session.transcript[0], { type: "user", content: "hello" });
    assert.strictEqual(first.value?.type, "text");
    assert.strictEqual(first.value?.content, "hi");

    let res = await iterator.next();
    while (!res.done) {
        res = await iterator.next();
    }
});

test("successful response records completed assistant item", async () => {
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
        if (event.type === "text") {
            received.push(event.content);
        }
        assert.strictEqual(session.transcript.length, 1);
    }

    assert.deepStrictEqual(received, ["Hello ", "world!"]);
    assert.strictEqual(session.transcript.length, 2);
    assert.deepStrictEqual(session.transcript[0], { type: "user", content: "greet" });
    assert.deepStrictEqual(session.transcript[1], {
        type: "assistant",
        content: "Hello world!",
        status: "completed",
    });
});

test("cancellation records partial assistant content as interrupted", async () => {
    const provider: ModelProvider = {
        id: "test",
        stream: (request: ModelRequest) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "chunk 1 " } satisfies ModelEvent;
                if (request.signal?.aborted) {
                    const err = new Error("Aborted");
                    err.name = "AbortError";
                    throw err;
                }
                yield { type: "text", content: "chunk 2 " } satisfies ModelEvent;
            },
        }),
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);
    const controller = new AbortController();

    const chunks: string[] = [];
    await assert.rejects(
        async () => {
            for await (const event of session.send("prompt", controller.signal)) {
                if (event.type === "text") {
                    chunks.push(event.content);
                }
                controller.abort();
            }
        },
        (err: any) => err.name === "AbortError" || /aborted/i.test(err.message),
    );

    assert.deepStrictEqual(chunks, ["chunk 1 "]);
    assert.strictEqual(session.transcript.length, 2);
    assert.deepStrictEqual(session.transcript[0], { type: "user", content: "prompt" });
    assert.deepStrictEqual(session.transcript[1], {
        type: "assistant",
        content: "chunk 1 ",
        status: "interrupted",
    });
    assert.strictEqual(session.isRunning, false);
});

test("cancellation before any text still records interrupted assistant item", async () => {
    const provider: ModelProvider = {
        id: "test",
        stream: () => ({
            async *[Symbol.asyncIterator]() {
                const err = new Error("Aborted before start");
                err.name = "AbortError";
                throw err;
            },
        }),
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        async () => {
            for await (const _ of session.send("cancelled immediately", controller.signal)) {
            }
        },
        (err: any) => err.name === "AbortError" || /aborted/i.test(err.message),
    );

    assert.strictEqual(session.transcript.length, 2);
    assert.deepStrictEqual(session.transcript[0], {
        type: "user",
        content: "cancelled immediately",
    });
    assert.deepStrictEqual(session.transcript[1], {
        type: "assistant",
        content: "",
        status: "interrupted",
    });
    assert.strictEqual(session.isRunning, false);
});

test("provider/runtime error records partial assistant as failed", async () => {
    const provider: ModelProvider = {
        id: "test",
        stream: () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "partial content " } satisfies ModelEvent;
                throw new Error("Network failure mid-stream");
            },
        }),
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);

    const chunks: string[] = [];
    await assert.rejects(async () => {
        for await (const event of session.send("prompt")) {
            if (event.type === "text") {
                chunks.push(event.content);
            }
        }
    }, /Network failure mid-stream/);

    assert.deepStrictEqual(chunks, ["partial content "]);
    assert.strictEqual(session.transcript.length, 2);
    assert.deepStrictEqual(session.transcript[0], { type: "user", content: "prompt" });
    assert.deepStrictEqual(session.transcript[1], {
        type: "assistant",
        content: "partial content ",
        status: "failed",
    });
    assert.strictEqual(session.isRunning, false);
});

test("consumer early break records assistant as interrupted", async () => {
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
        if (event.type === "text" && event.content === "token 1") {
            break;
        }
    }

    assert.strictEqual(session.isRunning, false);
    assert.strictEqual(session.transcript.length, 2);
    assert.deepStrictEqual(session.transcript[0], { type: "user", content: "early break" });
    assert.deepStrictEqual(session.transcript[1], {
        type: "assistant",
        content: "token 1",
        status: "interrupted",
    });
});

test("next generation after an interruption receives compiled interruption context", async () => {
    const recordedRequests: ModelRequest[] = [];
    let turn = 0;
    const provider: ModelProvider = {
        id: "test",
        stream: (request: ModelRequest) => {
            recordedRequests.push(request);
            turn++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (turn === 1) {
                        yield { type: "text", content: "const x = 1;" } satisfies ModelEvent;
                        const err = new Error("Aborted");
                        err.name = "AbortError";
                        throw err;
                    }
                    yield { type: "text", content: "let y = 2;" } satisfies ModelEvent;
                },
            };
        },
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);

    const controller = new AbortController();
    await assert.rejects(
        async () => {
            for await (const _ of session.send("write code", controller.signal)) {
                controller.abort();
            }
        },
        (err: any) => err.name === "AbortError" || /aborted/i.test(err.message),
    );

    // Turn 2
    for await (const _ of session.send("continue")) {
    }

    assert.strictEqual(recordedRequests.length, 2);
    // Turn 1 request
    assert.deepStrictEqual(recordedRequests[0].items, [
        { type: "message", role: "user", content: "write code" },
    ]);
    // Turn 2 request has compiled interruption context
    assert.deepStrictEqual(recordedRequests[1].items, [
        { type: "message", role: "user", content: "write code" },
        { type: "message", role: "assistant", content: "const x = 1;" },
        {
            type: "message",
            role: "system",
            content: "[Previous assistant generation was interrupted before completion]",
        },
        { type: "message", role: "user", content: "continue" },
    ]);
});

test("next generation after failure receives compiled failure context", async () => {
    const recordedRequests: ModelRequest[] = [];
    let turn = 0;
    const provider: ModelProvider = {
        id: "test",
        stream: (request: ModelRequest) => {
            recordedRequests.push(request);
            turn++;
            return {
                async *[Symbol.asyncIterator]() {
                    if (turn === 1) {
                        yield { type: "text", content: "step 1" } satisfies ModelEvent;
                        throw new Error("Temporary failure");
                    }
                    yield { type: "text", content: "done" } satisfies ModelEvent;
                },
            };
        },
    };
    const runtime = createAkkcoRuntime(provider);
    const session = new Session(runtime);

    await assert.rejects(async () => {
        for await (const _ of session.send("run step")) {
        }
    }, /Temporary failure/);

    // Turn 2
    for await (const _ of session.send("retry")) {
    }

    assert.strictEqual(recordedRequests.length, 2);
    assert.deepStrictEqual(recordedRequests[1].items, [
        { type: "message", role: "user", content: "run step" },
        { type: "message", role: "assistant", content: "step 1" },
        {
            type: "message",
            role: "system",
            content: "[Previous assistant generation failed]",
        },
        { type: "message", role: "user", content: "retry" },
    ]);
});

test("external callers cannot mutate transcript", async () => {
    const fakeRuntime = {
        run: (_request: ModelRequest) => ({
            async *[Symbol.asyncIterator]() {},
        }),
    };
    const session = new Session(fakeRuntime);

    for await (const _ of session.send("test")) {
    }
    assert.strictEqual(session.transcript.length, 2);

    const snapshot = session.transcript;
    (snapshot as any).push({ type: "assistant", content: "injected", status: "completed" });
    assert.strictEqual(session.transcript.length, 2);

    if (snapshot[0].type === "user") {
        snapshot[0].content = "tampered";
    }
    const firstItem = session.transcript[0];
    assert.strictEqual(firstItem.type, "user");
    assert.strictEqual(firstItem.content, "test");
});

test("in-flight lock: only one generation actively running per Session", async () => {
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
    assert.strictEqual(firstYield.value?.type, "text");
    assert.strictEqual(firstYield.value?.content, "running");
    assert.strictEqual(session.isRunning, true);

    // Consuming stream2 while stream1 is in-flight must fail immediately
    await assert.rejects(async () => {
        for await (const _ of stream2) {
        }
    }, /A generation is already in progress for this session/);

    // Stream 2 attempt did not alter session transcript
    assert.strictEqual(session.transcript.length, 1);
    assert.deepStrictEqual(session.transcript[0], { type: "user", content: "first" });

    // Complete stream 1
    unblockFirst!();
    let res = await it1.next();
    while (!res.done) {
        res = await it1.next();
    }

    assert.strictEqual(session.isRunning, false);
    assert.strictEqual(session.transcript.length, 2);
    assert.deepStrictEqual(session.transcript[1], {
        type: "assistant",
        content: "running done",
        status: "completed",
    });
});

test("lock releases after success/error/cancellation/early break", async () => {
    // 1. Success
    const runtimeSuccess = {
        run: () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "ok" } satisfies ModelEvent;
            },
        }),
    };
    const s1 = new Session(runtimeSuccess);
    for await (const _ of s1.send("1")) {
    }
    assert.strictEqual(s1.isRunning, false);

    // 2. Error
    const runtimeError = {
        run: () => {
            throw new Error("Sync error");
        },
    };
    const s2 = new Session(runtimeError);
    await assert.rejects(async () => {
        for await (const _ of s2.send("2")) {
        }
    }, /Sync error/);
    assert.strictEqual(s2.isRunning, false);

    // 3. Cancellation
    const runtimeAbort = {
        run: () => ({
            async *[Symbol.asyncIterator]() {
                const err = new Error("Abort");
                err.name = "AbortError";
                throw err;
            },
        }),
    };
    const s3 = new Session(runtimeAbort);
    await assert.rejects(async () => {
        for await (const _ of s3.send("3")) {
        }
    });
    assert.strictEqual(s3.isRunning, false);

    // 4. Early break
    const runtimeBreak = {
        run: () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "1" } satisfies ModelEvent;
                yield { type: "text", content: "2" } satisfies ModelEvent;
            },
        }),
    };
    const s4 = new Session(runtimeBreak);
    for await (const _ of s4.send("4")) {
        break;
    }
    assert.strictEqual(s4.isRunning, false);
});

test("clear() semantics remain correct", async () => {
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

    for await (const _ of session.send("msg")) {
    }
    assert.strictEqual(session.transcript.length, 2);

    session.clear();
    assert.strictEqual(session.transcript.length, 0);
    assert.deepStrictEqual(session.transcript, []);
});

test("assistant text before a tool is committed before tool transcript", async () => {
    const mockRuntime = {
        run: () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "text", content: "Let me check the repository." } as const;
                yield {
                    type: "tool_execution",
                    callId: "c1",
                    toolName: "list_files",
                    arguments: { path: "." },
                    result: "file1.ts\nfile2.ts",
                    status: "completed",
                    durationMs: 15,
                } as const;
                yield { type: "text", content: "Found 2 files." } as const;
            },
        }),
    };

    const session = new Session(mockRuntime as any);
    for await (const _ of session.send("check files")) {
    }

    const transcript = session.transcript;
    assert.strictEqual(transcript.length, 4);
    assert.deepStrictEqual(transcript[0], { type: "user", content: "check files" });
    assert.deepStrictEqual(transcript[1], {
        type: "assistant",
        content: "Let me check the repository.",
        status: "completed",
    });
    assert.strictEqual(transcript[2].type, "tool_execution");
    if (transcript[2].type === "tool_execution") {
        assert.strictEqual(transcript[2].callId, "c1");
        assert.strictEqual(transcript[2].toolName, "list_files");
        assert.strictEqual(transcript[2].status, "completed");
    }
    assert.deepStrictEqual(transcript[3], {
        type: "assistant",
        content: "Found 2 files.",
        status: "completed",
    });
});

test("successful tool execution recorded chronologically", async () => {
    const mockRuntime = {
        run: () => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: "tool_execution",
                    callId: "c2",
                    toolName: "read_file",
                    arguments: { path: "a.txt" },
                    result: "hello content",
                    status: "completed",
                    durationMs: 10,
                } as const;
                yield { type: "text", content: "Read complete." } as const;
            },
        }),
    };

    const session = new Session(mockRuntime as any);
    for await (const _ of session.send("read file")) {
    }

    const transcript = session.transcript;
    assert.strictEqual(transcript.length, 3);
    assert.deepStrictEqual(transcript[0], { type: "user", content: "read file" });
    assert.strictEqual(transcript[1].type, "tool_execution");
    if (transcript[1].type === "tool_execution") {
        assert.strictEqual(transcript[1].callId, "c2");
        assert.strictEqual(transcript[1].status, "completed");
        assert.strictEqual(transcript[1].result, "hello content");
    }
    assert.deepStrictEqual(transcript[2], {
        type: "assistant",
        content: "Read complete.",
        status: "completed",
    });
});

test("failed tool execution recorded chronologically", async () => {
    const mockRuntime = {
        run: () => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: "tool_execution",
                    callId: "c_fail",
                    toolName: "read_file",
                    arguments: { path: "missing.txt" },
                    error: "File not found",
                    status: "failed",
                    durationMs: 5,
                } as const;
                yield { type: "text", content: "Could not find file." } as const;
            },
        }),
    };

    const session = new Session(mockRuntime as any);
    for await (const _ of session.send("read missing")) {
    }

    const transcript = session.transcript;
    assert.strictEqual(transcript.length, 3);
    assert.deepStrictEqual(transcript[0], { type: "user", content: "read missing" });
    assert.strictEqual(transcript[1].type, "tool_execution");
    if (transcript[1].type === "tool_execution") {
        assert.strictEqual(transcript[1].callId, "c_fail");
        assert.strictEqual(transcript[1].status, "failed");
        assert.strictEqual(transcript[1].error, "File not found");
    }
    assert.deepStrictEqual(transcript[2], {
        type: "assistant",
        content: "Could not find file.",
        status: "completed",
    });
});

test("final assistant segment committed after tool interaction", async () => {
    const mockRuntime = {
        run: () => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: "tool_execution",
                    callId: "c3",
                    toolName: "calc",
                    arguments: {},
                    result: "42",
                    status: "completed",
                } as const;
                yield { type: "text", content: "Answer is " } as const;
                yield { type: "text", content: "42." } as const;
            },
        }),
    };

    const session = new Session(mockRuntime as any);
    for await (const _ of session.send("calculate")) {
    }

    const transcript = session.transcript;
    const last = transcript[transcript.length - 1];
    assert.strictEqual(last.type, "assistant");
    if (last.type === "assistant") {
        assert.strictEqual(last.content, "Answer is 42.");
        assert.strictEqual(last.status, "completed");
    }
});

test("interruption during later agent turn records correct partial segment", async () => {
    const controller = new AbortController();
    const mockRuntime = {
        run: () => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: "tool_execution",
                    callId: "c4",
                    toolName: "search",
                    arguments: {},
                    result: "match",
                    status: "completed",
                } as const;
                yield { type: "text", content: "Partial answer before interrupt" } as const;
                controller.abort();
                const err = new Error("Aborted");
                err.name = "AbortError";
                throw err;
            },
        }),
    };

    const session = new Session(mockRuntime as any);
    await assert.rejects(
        async () => {
            for await (const _ of session.send("search", controller.signal)) {
            }
        },
        (err: any) => err.name === "AbortError" || /aborted/i.test(err.message),
    );

    const transcript = session.transcript;
    assert.strictEqual(transcript.length, 3);
    assert.deepStrictEqual(transcript[0], { type: "user", content: "search" });
    assert.strictEqual(transcript[1].type, "tool_execution");
    if (transcript[1].type === "tool_execution") {
        assert.strictEqual(transcript[1].callId, "c4");
        assert.strictEqual(transcript[1].status, "completed");
    }
    assert.deepStrictEqual(transcript[2], {
        type: "assistant",
        content: "Partial answer before interrupt",
        status: "interrupted",
    });
});
