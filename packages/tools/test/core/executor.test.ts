import assert from "node:assert";
import test from "node:test";
import { z, ZodError } from "zod";
import { executeTool } from "../../src/index.js";
import type { ToolDefinition } from "../../src/index.js";

test("Valid input reaches execute() and returns ToolResult", async () => {
    let capturedInput: any;
    const testSchema = z.object({
        query: z.string(),
    });

    const tool: ToolDefinition<typeof testSchema> = {
        name: "test_tool",
        description: "Test tool",
        inputSchema: testSchema,
        execute: async (input) => {
            capturedInput = input;
            return {
                content: `Processed: ${input.query}`,
            };
        },
    };

    const result = await executeTool(tool, { query: "hello world" });
    assert.deepStrictEqual(capturedInput, { query: "hello world" });
    assert.deepStrictEqual(result, { content: "Processed: hello world" });
});

test("Invalid input is rejected by Zod and throws ZodError", async () => {
    const testSchema = z.object({
        count: z.number(),
    });

    const tool: ToolDefinition<typeof testSchema> = {
        name: "counter",
        description: "Count",
        inputSchema: testSchema,
        execute: async () => ({ content: "ok" }),
    };

    await assert.rejects(async () => {
        await executeTool(tool, { count: "not-a-number" });
    }, (err: any) => err instanceof ZodError);
});

test("execute() is not called when validation fails", async () => {
    let executeCalled = false;
    const testSchema = z.object({
        id: z.string().min(5),
    });

    const tool: ToolDefinition<typeof testSchema> = {
        name: "validator",
        description: "Validates id",
        inputSchema: testSchema,
        execute: async () => {
            executeCalled = true;
            return { content: "ok" };
        },
    };

    await assert.rejects(async () => {
        await executeTool(tool, { id: "123" }); // shorter than 5 chars
    }, (err: any) => err instanceof ZodError);

    assert.strictEqual(executeCalled, false);
});

test("Zod transformations and defaults are passed as parsed values rather than raw input", async () => {
    let receivedInput: any;
    const transformSchema = z.object({
        code: z.string().transform((val) => val.toUpperCase()),
        limit: z.number().default(10),
    });

    const tool: ToolDefinition<typeof transformSchema> = {
        name: "transformer",
        description: "Transforms input",
        inputSchema: transformSchema,
        execute: async (input) => {
            receivedInput = input;
            return { content: `${input.code}:${input.limit}` };
        },
    };

    const result = await executeTool(tool, { code: "akkco" });
    assert.deepStrictEqual(receivedInput, { code: "AKKCO", limit: 10 });
    assert.deepStrictEqual(result, { content: "AKKCO:10" });
});
