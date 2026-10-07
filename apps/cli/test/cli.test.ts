import { createAkkcoRuntime, type RuntimeEvent, type RuntimeToolHost } from "@akkco/core";
import type { ModelEvent, ModelMessage, ModelProvider, ModelRequest } from "@akkco/models";
import { createTextToolCompatibilityProvider } from "@akkco/providers";
import { createToolRegistry } from "@akkco/tools";
import assert from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMaxToolIterations, parseToolMode } from "../src/config.js";
import { createCliController } from "../src/state/cli-controller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, "../src/index.ts");
const tsxBin = path.resolve(__dirname, "../../../node_modules/.bin/tsx");

const waitForOutput = async (predicate: () => boolean, timeoutMs = 5000) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for output after ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 20));
    }
};

const waitForExit = (cp: ChildProcess): Promise<number | null> => {
    if (cp.exitCode !== null) {
        return Promise.resolve(cp.exitCode);
    }
    return new Promise<number | null>((resolve) => cp.on("exit", resolve));
};

test("Ctrl+C (SIGINT) cancels active generation without killing the CLI, allowing subsequent generation", async () => {
    let turnCount = 0;
    const server = http.createServer((req, res) => {
        turnCount++;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (turnCount === 1) {
            // First turn: slow generation that will be aborted
            res.write(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "slow response" } }] })}\n\n`,
            );
        } else {
            // Second turn: fast generation that completes
            res.write(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "completed second response" } }] })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
        }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    const cp = spawn(tsxBin, [cliEntry], {
        env: { ...process.env, AKKCO_BASE_URL: `http://127.0.0.1:${port}/v1` },
        stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    cp.stdout.on("data", (d) => (output += d.toString()));
    cp.stderr.on("data", (d) => (output += d.toString()));

    try {
        await waitForOutput(() => output.includes("> "));

        // 1. Send first message
        cp.stdin.write("first turn\n");
        await waitForOutput(() => output.includes("slow response"));

        // 2. Send SIGINT to cancel active generation
        cp.kill("SIGINT");
        await waitForOutput(() => output.includes("Generation cancelled."));

        // 3. Send second message to verify CLI is still alive and Session can run another generation
        cp.stdin.write("second turn\n");
        await waitForOutput(() => output.includes("completed second response"));

        // 4. Send /exit
        cp.stdin.write("/exit\n");

        const exitCode = await waitForExit(cp);
        assert.strictEqual(exitCode, 0);

        assert.match(output, /slow response/);
        assert.match(output, /Generation cancelled\./);
        assert.match(output, /completed second response/);
        assert.match(output, /Goodbye\./);
    } finally {
        cp.kill();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("Ctrl+C (SIGINT) while idle at the prompt cleanly exits the CLI", async () => {
    const cp = spawn(tsxBin, [cliEntry], {
        env: { ...process.env, AKKCO_BASE_URL: "http://127.0.0.1:1/v1" },
        stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    cp.stdout.on("data", (d) => (output += d.toString()));

    await waitForOutput(() => output.includes("> "));

    // Send SIGINT while idle
    cp.kill("SIGINT");

    const exitCode = await waitForExit(cp);
    assert.ok(exitCode === 0 || exitCode === 130, `Unexpected exit code: ${exitCode}`);
    assert.match(output, /Akkco Code/);
});

test("CLI /tools and /tool commands execute tools and handle errors gracefully", async () => {
    const cp = spawn(tsxBin, [cliEntry], {
        cwd: path.resolve(__dirname, "../../.."),
        env: { ...process.env, AKKCO_BASE_URL: "http://127.0.0.1:1/v1" },
        stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    cp.stdout.on("data", (d) => (output += d.toString()));
    cp.stderr.on("data", (d) => (output += d.toString()));

    try {
        await waitForOutput(() => output.includes("> "));

        // 1. Test /tools
        cp.stdin.write("/tools\n");
        await waitForOutput(() => output.includes("Available tools:"));

        // 2. Test valid /tool execution
        cp.stdin.write('/tool read_file {"path":"packages/tools/package.json"}\n');
        await waitForOutput(() => output.includes('"@akkco/tools"'));

        // 3. Test invalid JSON error handling
        cp.stdin.write("/tool read_file {invalid-json\n");
        await waitForOutput(() => output.includes("Error: Invalid JSON input for tool."));

        // 4. Test unknown tool error handling
        cp.stdin.write("/tool unknown_tool {}\n");
        await waitForOutput(() => output.includes("Error: Unknown tool: unknown_tool"));

        // 5. Clean exit
        cp.stdin.write("/exit\n");

        const exitCode = await waitForExit(cp);
        assert.strictEqual(exitCode, 0);

        // Verify /tools output
        assert.match(output, /Available tools:/);
        assert.match(output, /read_file: Read the full contents/);
        assert.match(output, /list_files: List immediate files/);
        assert.match(output, /search_text: Search recursively/);

        // Verify valid tool execution output
        assert.match(output, /"@akkco\/tools"/);

        // Verify error messages
        assert.match(output, /Error: Invalid JSON input for tool\./);
        assert.match(output, /Error: Unknown tool: unknown_tool/);
        assert.match(output, /Goodbye\./);
    } finally {
        cp.kill();
    }
});

test("CLI rejects invalid AKKCO_TOOL_MODE with error code 1", async () => {
    const cp = spawn(tsxBin, [cliEntry], {
        env: { ...process.env, AKKCO_TOOL_MODE: "unsupported_mode" },
        stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    cp.stderr.on("data", (d) => (stderr += d.toString()));

    const exitCode = await waitForExit(cp);
    assert.strictEqual(exitCode, 1);
    assert.match(stderr, /Invalid AKKCO_TOOL_MODE: "unsupported_mode"/);
});

test("CLI accepts AKKCO_TOOL_MODE=compatibility cleanly", async () => {
    const cp = spawn(tsxBin, [cliEntry], {
        env: {
            ...process.env,
            AKKCO_TOOL_MODE: "compatibility",
            AKKCO_BASE_URL: "http://127.0.0.1:1/v1",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    cp.stdout.on("data", (d) => (output += d.toString()));

    await waitForOutput(() => output.includes("> "));
    cp.stdin.write("/exit\n");

    const exitCode = await waitForExit(cp);
    assert.strictEqual(exitCode, 0);
    assert.match(output, /Akkco Code/);
    assert.match(output, /Goodbye\./);
});

for (const mode of ["native", "compatibility"]) {
    test(
        `CLI displays agent tool executions in chronological order in ${mode} mode`,
        { timeout: 10000 },
        async () => {
            let requests = 0;

            const server = http.createServer((_req, res) => {
                requests++;
                res.writeHead(200, { "Content-Type": "text/event-stream" });

                const send = (delta: unknown) =>
                    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);

                if (requests === 1) {
                    if (mode === "native") {
                        send({ content: "Before tool." });
                        send({
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "read-call",
                                    type: "function",
                                    function: {
                                        name: "read_file",
                                        arguments: '{"path":"apps/cli/package.json"}',
                                    },
                                },
                            ],
                        });
                    } else {
                        send({
                            content:
                                '<akkco_tool_call>{"name":"read_file","arguments":{"path":"apps/cli/package.json"}}</akkco_tool_call>',
                        });
                    }
                } else {
                    send({ content: "After tool." });
                }

                res.end("data: [DONE]\n\n");
            });

            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const address = server.address();
            assert.ok(address && typeof address !== "string");

            const cp = spawn(tsxBin, [cliEntry], {
                cwd: path.resolve(__dirname, "../../.."),
                env: {
                    ...process.env,
                    AKKCO_TOOL_MODE: mode,
                    AKKCO_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
                    FORCE_COLOR: "3",
                    NO_COLOR: undefined,
                },
                stdio: ["pipe", "pipe", "pipe"],
            });

            let output = "";
            let errors = "";

            cp.stdout.on("data", (data) => {
                output += data.toString();
            });

            cp.stderr.on("data", (data) => {
                errors += data.toString();
            });

            try {
                cp.stdin.end("inspect the CLI\n");

                assert.strictEqual(await waitForExit(cp), 0);
                assert.strictEqual(requests, 2);
                assert.strictEqual(errors, "");
                assert.match(output, /Tool: read_file/);
                assert.match(output, /args: \{"path":"apps\/cli\/package.json"\}/);
                assert.match(output, /✔ completed \(\d+ms\)/);

                if (mode === "native") {
                    assert.ok(output.indexOf("Before tool.") < output.indexOf("Tool: read_file"));
                    assert.strictEqual(output.split("Before tool.").length - 1, 1);
                }

                assert.ok(output.indexOf("Tool: read_file") < output.indexOf("After tool."));
                assert.strictEqual(output.split("After tool.").length - 1, 1);
                assert.doesNotMatch(output, /\x1b|█|<akkco_tool_call>/);
            } finally {
                cp.kill();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        },
    );
}

test(
    "CLI queues piped turns, clears conversation context, and drains the final line before EOF",
    { timeout: 10000 },
    async () => {
        const userTurns: string[][] = [];

        const server = http.createServer((req, res) => {
            let body = "";

            req.on("data", (data) => {
                body += data.toString();
            });

            req.on("end", () => {
                const request = JSON.parse(body);
                userTurns.push(
                    request.messages
                        .filter((message: { role: string }) => message.role === "user")
                        .map((message: { content: string }) => message.content),
                );
                const number = userTurns.length;
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write(
                    `data: ${JSON.stringify({ choices: [{ delta: { content: `response ${number}` } }] })}\n\n`,
                );
                setTimeout(() => res.end("data: [DONE]\n\n"), 30);
            });
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");

        const cp = spawn(tsxBin, [cliEntry], {
            env: {
                ...process.env,
                AKKCO_TOOL_MODE: "native",
                AKKCO_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            },
            stdio: ["pipe", "pipe", "pipe"],
        });

        let output = "";

        cp.stdout.on("data", (data) => {
            output += data.toString();
        });

        cp.stderr.on("data", (data) => {
            output += data.toString();
        });

        try {
            cp.stdin.end("first\nsecond\n/clear\nthird");

            assert.strictEqual(await waitForExit(cp), 0);
            assert.deepStrictEqual(userTurns, [["first"], ["first", "second"], ["third"]]);
            assert.match(
                output,
                /response 1[\s\S]*response 2[\s\S]*Conversation cleared\.[\s\S]*response 3/,
            );
            assert.strictEqual(output.split("Akkco Code").length - 1, 1);
            assert.doesNotMatch(output, /Error:|\x1b|█/);
        } finally {
            cp.kill();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
);

test(
    "CLI exits with empty piped input and ignores queued lines after /exit",
    { timeout: 10000 },
    async () => {
        for (const input of ["", "/tools\n/exit\n/tool unknown_tool {}\n"]) {
            const cp = spawn(tsxBin, [cliEntry], { stdio: ["pipe", "pipe", "pipe"] });

            let output = "";

            cp.stdout.on("data", (data) => {
                output += data.toString();
            });

            cp.stderr.on("data", (data) => {
                output += data.toString();
            });

            try {
                cp.stdin.end(input);

                assert.strictEqual(await waitForExit(cp), 0);
                assert.match(output, /Akkco Code v0\.0\.1/);
                assert.doesNotMatch(output, /Unknown tool|\x1b|█/);

                if (input) {
                    assert.match(output, /Available tools:/);
                    assert.strictEqual(output.split("Goodbye.").length - 1, 1);
                }
            } finally {
                cp.kill();
            }
        }
    },
);

test("parseMaxToolIterations validates and parses environment variable correctly", () => {
    assert.strictEqual(parseMaxToolIterations(undefined), undefined);
    assert.strictEqual(parseMaxToolIterations("25"), 25);
    assert.strictEqual(parseMaxToolIterations("  10  "), 10);
    assert.throws(() => parseMaxToolIterations(""), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
    assert.throws(() => parseMaxToolIterations("0"), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
    assert.throws(() => parseMaxToolIterations("-1"), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
    assert.throws(() => parseMaxToolIterations("abc"), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
    assert.throws(() => parseMaxToolIterations("1.5"), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
    assert.throws(() => parseMaxToolIterations("Infinity"), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
    assert.throws(() => parseMaxToolIterations("-Infinity"), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
    assert.throws(() => parseMaxToolIterations("NaN"), /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
});

test("parseToolMode defaults to compatibility and validates input cleanly", () => {
    assert.strictEqual(parseToolMode(undefined), "compatibility");
    assert.strictEqual(parseToolMode("compatibility"), "compatibility");
    assert.strictEqual(parseToolMode("native"), "native");
    assert.throws(() => parseToolMode(""), /Invalid AKKCO_TOOL_MODE/);
    assert.throws(() => parseToolMode("unsupported_mode"), /Invalid AKKCO_TOOL_MODE/);
});

test(
    "CLI defaults tool mode to compatibility when AKKCO_TOOL_MODE is unset",
    { timeout: 10000 },
    async () => {
        let requestBody: any;
        const server = http.createServer((req, res) => {
            let body = "";
            req.on("data", (d) => (body += d.toString()));
            req.on("end", () => {
                requestBody = JSON.parse(body);
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write(
                    `data: ${JSON.stringify({
                        choices: [
                            {
                                delta: {
                                    content:
                                        '<akkco_tool_call>{"name":"read_file","arguments":{"path":"apps/cli/package.json"}}</akkco_tool_call>',
                                },
                            },
                        ],
                    })}\n\n`,
                );
                res.end("data: [DONE]\n\n");
            });
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as any;

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            AKKCO_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        };
        delete env.AKKCO_TOOL_MODE;

        const cp = spawn(tsxBin, [cliEntry], {
            cwd: path.resolve(__dirname, "../../.."),
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let output = "";
        cp.stdout.on("data", (d) => (output += d.toString()));
        cp.stderr.on("data", (d) => (output += d.toString()));

        try {
            cp.stdin.end("inspect CLI\n");
            const exitCode = await waitForExit(cp);
            assert.strictEqual(exitCode, 0);
            assert.strictEqual(requestBody.tools, undefined);
            assert.ok(
                requestBody.messages.some(
                    (m: any) => m.role === "system" && m.content.includes("<akkco_tool_call>"),
                ),
            );
            assert.match(output, /Tool: read_file/);
            assert.match(output, /✔ completed/);
        } finally {
            cp.kill();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
);

test("CLI respects explicit AKKCO_TOOL_MODE=native", { timeout: 10000 }, async () => {
    let requestBody: any;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (d) => (body += d.toString()));
        req.on("end", () => {
            requestBody = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write(
                `data: ${JSON.stringify({
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: "read-call",
                                        type: "function",
                                        function: {
                                            name: "read_file",
                                            arguments: '{"path":"apps/cli/package.json"}',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                })}\n\n`,
            );
            res.end("data: [DONE]\n\n");
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as any;

    const cp = spawn(tsxBin, [cliEntry], {
        cwd: path.resolve(__dirname, "../../.."),
        env: {
            ...process.env,
            AKKCO_TOOL_MODE: "native",
            AKKCO_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    cp.stdout.on("data", (d) => (output += d.toString()));
    cp.stderr.on("data", (d) => (output += d.toString()));

    try {
        cp.stdin.end("inspect CLI\n");
        const exitCode = await waitForExit(cp);
        assert.strictEqual(exitCode, 0);
        assert.ok(Array.isArray(requestBody.tools) && requestBody.tools.length > 0);
        assert.match(output, /Tool: read_file/);
        assert.match(output, /✔ completed/);
    } finally {
        cp.kill();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test(
    "CLI reports clear configuration error on invalid AKKCO_MAX_TOOL_ITERATIONS",
    { timeout: 10000 },
    async () => {
        for (const invalidVal of ["invalid", "-5", "0", "1.5", "Infinity"]) {
            const cp = spawn(tsxBin, [cliEntry], {
                env: { ...process.env, AKKCO_MAX_TOOL_ITERATIONS: invalidVal },
                stdio: ["pipe", "pipe", "pipe"],
            });

            let output = "";
            cp.stdout.on("data", (d) => (output += d.toString()));
            cp.stderr.on("data", (d) => (output += d.toString()));

            cp.stdin.end("");

            const exitCode = await waitForExit(cp);
            assert.strictEqual(exitCode, 1);
            assert.match(output, /Invalid AKKCO_MAX_TOOL_ITERATIONS/);
            assert.match(output, /Must be a finite positive integer/);
        }
    },
);

test(
    "CLI enforces valid AKKCO_MAX_TOOL_ITERATIONS injection end-to-end",
    { timeout: 10000 },
    async () => {
        let requestCount = 0;
        const server = http.createServer((_req, res) => {
            requestCount++;
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write(
                `data: ${JSON.stringify({
                    choices: [
                        {
                            delta: {
                                content: `<akkco_tool_call>{"name":"read_file","arguments":{"path":"apps/cli/package.json"}}</akkco_tool_call>`,
                            },
                        },
                    ],
                })}\n\n`,
            );
            res.end("data: [DONE]\n\n");
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as any;

        const cp = spawn(tsxBin, [cliEntry], {
            cwd: path.resolve(__dirname, "../../.."),
            env: {
                ...process.env,
                AKKCO_MAX_TOOL_ITERATIONS: "1",
                AKKCO_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            },
            stdio: ["pipe", "pipe", "pipe"],
        });

        let output = "";
        cp.stdout.on("data", (d) => (output += d.toString()));
        cp.stderr.on("data", (d) => (output += d.toString()));

        try {
            cp.stdin.end("run tool loop\n");
            const exitCode = await waitForExit(cp);
            assert.strictEqual(exitCode, 0);
            assert.match(output, /Tool: read_file/);
            assert.match(output, /Error: Maximum tool iterations exceeded/);
            assert.strictEqual(requestCount, 2);
        } finally {
            cp.kill();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
);

test("createCliController has no environment dependency and accepts reliabilityOptions directly", async () => {
    const originalMaxIterations = process.env.AKKCO_MAX_TOOL_ITERATIONS;
    const originalToolMode = process.env.AKKCO_TOOL_MODE;

    try {
        process.env.AKKCO_MAX_TOOL_ITERATIONS = "invalid_not_a_number";
        process.env.AKKCO_TOOL_MODE = "invalid_mode";

        const dummyProvider: ModelProvider = {
            id: "dummy",
            stream: () => ({
                async *[Symbol.asyncIterator]() {
                    yield { type: "text", content: "pong" };
                },
            }),
        };
        const registry = createToolRegistry();

        const controllerWithoutOptions = createCliController({
            provider: dummyProvider,
            toolRegistry: registry,
        });
        assert.ok(controllerWithoutOptions);
        controllerWithoutOptions.dispose();

        const controllerWithOptions = createCliController({
            provider: dummyProvider,
            toolRegistry: registry,
            reliabilityOptions: { maxToolIterations: 3 },
        });
        assert.ok(controllerWithOptions);
        controllerWithOptions.dispose();
    } finally {
        if (originalMaxIterations === undefined) {
            delete process.env.AKKCO_MAX_TOOL_ITERATIONS;
        } else {
            process.env.AKKCO_MAX_TOOL_ITERATIONS = originalMaxIterations;
        }
        if (originalToolMode === undefined) {
            delete process.env.AKKCO_TOOL_MODE;
        } else {
            process.env.AKKCO_TOOL_MODE = originalToolMode;
        }
    }
});

test("Runtime integration preserves assistant pre-tool text before tool execution", async () => {
    let turnCount = 0;
    const capturedRequests: ModelRequest[] = [];

    const innerProvider: ModelProvider = {
        id: "mock-inner",
        stream: (request: ModelRequest) => {
            capturedRequests.push(request);
            turnCount++;
            if (turnCount === 1) {
                return {
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: "text",
                            content:
                                'I will inspect the file.\n\n<akkco_tool_call>{"name":"read_file","arguments":{"path":"foo.ts"}}</akkco_tool_call>',
                        } satisfies ModelEvent;
                    },
                };
            }
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: "text",
                        content: "File contains foo details.",
                    } satisfies ModelEvent;
                },
            };
        },
    };

    const compatProvider = createTextToolCompatibilityProvider(innerProvider);

    let executedTool = false;
    const toolHost: RuntimeToolHost = {
        tools: [
            {
                name: "read_file",
                description: "read file",
                inputSchema: { type: "object", properties: { path: { type: "string" } } },
            },
        ],
        execute: async (name, args: any) => {
            executedTool = true;
            assert.strictEqual(name, "read_file");
            assert.deepStrictEqual(args, { path: "foo.ts" });
            return { content: "foo content" };
        },
    };

    const runtime = createAkkcoRuntime(compatProvider, toolHost);
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.run({
        items: [{ type: "message", role: "user", content: "read foo.ts" }],
    })) {
        events.push(event);
    }

    assert.strictEqual(turnCount, 2);
    assert.strictEqual(executedTool, true);

    // Verify events sequence delivered by Runtime
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(events[0], { type: "text", content: "I will inspect the file.\n\n" });
    assert.strictEqual(events[1].type, "tool_execution");
    if (events[1].type === "tool_execution") {
        assert.strictEqual(events[1].toolName, "read_file");
        assert.strictEqual(events[1].status, "completed");
        assert.strictEqual(events[1].result, "foo content");
    }
    assert.deepStrictEqual(events[2], { type: "text", content: "File contains foo details." });

    // Verify that the second request sent to the provider preserved the assistant pre-tool text
    assert.strictEqual(capturedRequests.length, 2);
    const secondReq = capturedRequests[1];
    // In compatibility mode, items[0] is system tool instructions.
    // items[1] is the user request.
    // items[2] is the assistant message containing the pre-tool prose and tool envelope.
    const assistantMsg = secondReq.items.find(
        (it): it is ModelMessage => it.type === "message" && it.role === "assistant",
    );
    assert.ok(assistantMsg);
    assert.match(assistantMsg.content, /^I will inspect the file\.\n\n<akkco_tool_call>/);
    assert.match(assistantMsg.content, /"name":"read_file"/);
    assert.match(assistantMsg.content, /<\/akkco_tool_call>$/);
});
