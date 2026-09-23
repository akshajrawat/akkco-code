import assert from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, "../src/index.ts");
const tsxBin = path.resolve(__dirname, "../../../node_modules/.bin/tsx");

test("Ctrl+C (SIGINT) cancels active generation without killing the CLI, allowing subsequent generation", async () => {
    let turnCount = 0;
    const server = http.createServer((req, res) => {
        turnCount++;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (turnCount === 1) {
            // First turn: slow generation that will be aborted
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "slow response" } }] })}\n\n`);
        } else {
            // Second turn: fast generation that completes
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "completed second response" } }] })}\n\n`);
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
        // Wait for CLI to start up and print prompt
        await new Promise((r) => setTimeout(r, 600));

        // 1. Send first message
        cp.stdin.write("first turn\n");
        await new Promise((r) => setTimeout(r, 300));

        // 2. Send SIGINT to cancel active generation
        cp.kill("SIGINT");
        await new Promise((r) => setTimeout(r, 300));

        // 3. Send second message to verify CLI is still alive and Session can run another generation
        cp.stdin.write("second turn\n");
        await new Promise((r) => setTimeout(r, 400));

        // 4. Send /exit
        cp.stdin.write("/exit\n");

        const exitCode = await new Promise<number | null>((resolve) => cp.on("exit", resolve));
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

    // Wait for prompt
    await new Promise((r) => setTimeout(r, 600));

    // Send SIGINT while idle
    cp.kill("SIGINT");

    const exitCode = await new Promise<number | null>((resolve) => cp.on("exit", resolve));
    // POSIX SIGINT exit status is non-zero (130) or clean exit (0)
    assert.ok(exitCode === 0 || exitCode === 130, `Unexpected exit code: ${exitCode}`);
    assert.match(output, /Akkco Code/);
});
