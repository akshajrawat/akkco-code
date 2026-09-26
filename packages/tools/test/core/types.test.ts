import assert from "node:assert";
import test from "node:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/index.js";
import type { AnyToolDefinition, ToolDefinition, ToolResult } from "../../src/index.js";

test("ToolDefinition correctly types schema and inferred execute input", async () => {
    const calculatorSchema = z.object({
        a: z.number(),
        b: z.number(),
    });

    const addTool: ToolDefinition<typeof calculatorSchema> = {
        name: "add",
        description: "Adds two numbers",
        inputSchema: calculatorSchema,
        execute: async (input) => {
            // input is inferred as { a: number; b: number }
            const sum = input.a + input.b;
            return {
                content: `Sum: ${sum}`,
            };
        },
    };

    assert.strictEqual(addTool.name, "add");
    assert.strictEqual(addTool.description, "Adds two numbers");

    const validatedInput = addTool.inputSchema.parse({ a: 10, b: 25 });
    const result: ToolResult = await addTool.execute(validatedInput);

    assert.deepStrictEqual(result, { content: "Sum: 35" });
});

test("Invalid properties on concrete execute input are rejected by TypeScript", async () => {
    const userSchema = z.object({
        username: z.string(),
    });

    const userTool: ToolDefinition<typeof userSchema> = {
        name: "user",
        description: "User tool",
        inputSchema: userSchema,
        execute: async (input) => {
            // @ts-expect-error - 'nonExistentProperty' does not exist on type '{ username: string; }'
            const _bad = input.nonExistentProperty;

            // @ts-expect-error - Type 'number' is not assignable to type 'string'
            const _wrongType: number = input.username;

            return { content: input.username };
        },
    };

    const res = await userTool.execute({ username: "alice" });
    assert.strictEqual(res.content, "alice");
});

test("ToolDefinition cannot be used without a generic parameter", () => {
    // @ts-expect-error - Generic type 'ToolDefinition' requires 1 type argument(s)
    type RawTool = ToolDefinition;

    assert.ok(true);
});

test("Heterogeneous tools can coexist in ToolRegistry through AnyToolDefinition", async () => {
    const stringSchema = z.object({ text: z.string() });
    const stringTool: ToolDefinition<typeof stringSchema> = {
        name: "string_tool",
        description: "Accepts text",
        inputSchema: stringSchema,
        execute: async (input) => ({ content: input.text.toUpperCase() }),
    };

    const numberSchema = z.object({ value: z.number() });
    const numberTool: ToolDefinition<typeof numberSchema> = {
        name: "number_tool",
        description: "Accepts number",
        inputSchema: numberSchema,
        execute: async (input) => ({ content: String(input.value * 2) }),
    };

    // Both concrete tools assignable to AnyToolDefinition array
    const tools: AnyToolDefinition[] = [stringTool, numberTool];
    const registry = new ToolRegistry(tools);

    assert.strictEqual(registry.list().length, 2);
    const resA = await registry.execute("string_tool", { text: "hello" });
    const resB = await registry.execute("number_tool", { value: 21 });
    assert.strictEqual(resA.content, "HELLO");
    assert.strictEqual(resB.content, "42");
});
