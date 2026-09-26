import assert from "node:assert";
import test from "node:test";
import { z, ZodError } from "zod";
import {
    createRepositoryTools,
    createToolRegistry,
    ToolRegistry,
} from "../../src/index.js";
import type { ToolDefinition } from "../../src/index.js";

test("Tool registration and retrieval", () => {
    const registry = new ToolRegistry();
    const schema = z.object({ value: z.string() });
    const tool: ToolDefinition<typeof schema> = {
        name: "test_tool",
        description: "A test tool",
        inputSchema: schema,
        execute: async (input) => ({ content: input.value }),
    };

    registry.register(tool);
    assert.strictEqual(registry.get("test_tool"), tool);
    assert.strictEqual(registry.get("missing"), undefined);
});

test("Listing registered tools", () => {
    const schema = z.object({});
    const tool1: ToolDefinition<typeof schema> = {
        name: "tool_1",
        description: "First tool",
        inputSchema: schema,
        execute: async () => ({ content: "1" }),
    };
    const tool2: ToolDefinition<typeof schema> = {
        name: "tool_2",
        description: "Second tool",
        inputSchema: schema,
        execute: async () => ({ content: "2" }),
    };

    const registry = createToolRegistry([tool1, tool2]);
    const tools = registry.list();

    assert.strictEqual(tools.length, 2);
    assert.deepStrictEqual(tools.map((t) => t.name), ["tool_1", "tool_2"]);
});

test("Duplicate tool registration error", () => {
    const registry = new ToolRegistry();
    const schema = z.object({});
    const tool1: ToolDefinition<typeof schema> = {
        name: "duplicate_tool",
        description: "Tool",
        inputSchema: schema,
        execute: async () => ({ content: "ok" }),
    };
    const tool2: ToolDefinition<typeof schema> = {
        name: "duplicate_tool",
        description: "Another tool with same name",
        inputSchema: schema,
        execute: async () => ({ content: "ok" }),
    };

    registry.register(tool1);
    assert.throws(
        () => registry.register(tool2),
        /Tool already registered: duplicate_tool/
    );
});

test("Unknown tool execution error", async () => {
    const registry = new ToolRegistry();

    await assert.rejects(
        async () => registry.execute("non_existent", {}),
        /Unknown tool: non_existent/
    );
});

test("Valid execution through the registry", async () => {
    const registry = new ToolRegistry();
    const schema = z.object({
        name: z.string(),
        times: z.number().default(1),
    });

    const tool: ToolDefinition<typeof schema> = {
        name: "greeter",
        description: "Greets someone",
        inputSchema: schema,
        execute: async (input) => ({
            content: `Hello ${input.name}!`.repeat(input.times),
        }),
    };

    registry.register(tool);

    const result = await registry.execute("greeter", { name: "Alice", times: 2 });
    assert.deepStrictEqual(result, { content: "Hello Alice!Hello Alice!" });
});

test("Invalid input failing schema validation before execute() runs", async () => {
    let executeCalled = false;
    const schema = z.object({
        requiredField: z.string(),
    });

    const tool: ToolDefinition<typeof schema> = {
        name: "guarded",
        description: "Guarded tool",
        inputSchema: schema,
        execute: async () => {
            executeCalled = true;
            return { content: "executed" };
        },
    };

    const registry = new ToolRegistry();
    registry.register(tool);

    await assert.rejects(
        async () => registry.execute("guarded", { wrongField: 123 }),
        (err: unknown) => err instanceof ZodError
    );

    assert.strictEqual(executeCalled, false);
});

test("createRepositoryTools bundles read_file, list_files, and search_text", () => {
    const tools = createRepositoryTools(process.cwd());
    assert.strictEqual(tools.length, 3);
    const names = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ["list_files", "read_file", "search_text"]);

    const registry = createToolRegistry(tools);
    assert.ok(registry.get("read_file"));
    assert.ok(registry.get("list_files"));
    assert.ok(registry.get("search_text"));
});
