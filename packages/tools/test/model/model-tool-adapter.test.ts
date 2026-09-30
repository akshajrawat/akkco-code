import assert from "node:assert";
import test from "node:test";
import { z } from "zod";
import {
    createListFilesTool,
    createReadFileTool,
    createRepositoryTools,
    createSearchTextTool,
    executeTool,
    toModelTool,
    toModelTools,
} from "../../src/index.js";
import type { ToolDefinition } from "../../src/index.js";

test("read_file converts to correct ModelTool description", () => {
    const readFileTool = createReadFileTool("/dummy/root");
    const modelTool = toModelTool(readFileTool);

    assert.strictEqual(modelTool.name, "read_file");
    assert.strictEqual(
        modelTool.description,
        "Read the full contents of a file from the repository as UTF-8 text.",
    );
    assert.strictEqual(modelTool.inputSchema.type, "object");

    const properties = modelTool.inputSchema.properties as Record<string, any>;
    assert.ok(properties);
    assert.strictEqual(properties.path?.type, "string");

    const required = modelTool.inputSchema.required as string[];
    assert.ok(Array.isArray(required));
    assert.ok(required.includes("path"));
});

test("list_files reflects optional path correctly", () => {
    const listFilesTool = createListFilesTool("/dummy/root");
    const modelTool = toModelTool(listFilesTool);

    assert.strictEqual(modelTool.name, "list_files");
    assert.strictEqual(
        modelTool.description,
        "List immediate files and directories in a repository directory.",
    );
    assert.strictEqual(modelTool.inputSchema.type, "object");

    const properties = modelTool.inputSchema.properties as Record<string, any>;
    assert.ok(properties);
    assert.strictEqual(properties.path?.type, "string");

    const required = modelTool.inputSchema.required as string[] | undefined;
    if (required) {
        assert.strictEqual(required.includes("path"), false);
    }
});

test("search_text reflects required query and optional path", () => {
    const searchTextTool = createSearchTextTool("/dummy/root");
    const modelTool = toModelTool(searchTextTool);

    assert.strictEqual(modelTool.name, "search_text");
    assert.strictEqual(
        modelTool.description,
        "Search recursively for literal text within files in the repository.",
    );
    assert.strictEqual(modelTool.inputSchema.type, "object");

    const properties = modelTool.inputSchema.properties as Record<string, any>;
    assert.ok(properties);
    assert.strictEqual(properties.query?.type, "string");
    assert.strictEqual(properties.path?.type, "string");

    const required = modelTool.inputSchema.required as string[];
    assert.ok(Array.isArray(required));
    assert.ok(required.includes("query"));
    assert.strictEqual(required.includes("path"), false);
});

test("execute is never present in ModelTool output", () => {
    const readFileTool = createReadFileTool("/dummy/root");
    const listFilesTool = createListFilesTool("/dummy/root");
    const searchTextTool = createSearchTextTool("/dummy/root");

    const customTool: ToolDefinition<any> = {
        name: "custom_tool",
        description: "Custom tool description",
        inputSchema: z.object({ count: z.number() }),
        execute: async (input) => ({ content: String(input.count) }),
    };

    const tools = [readFileTool, listFilesTool, searchTextTool, customTool];

    for (const tool of tools) {
        const modelTool = toModelTool(tool);

        assert.strictEqual("execute" in modelTool, false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(modelTool, "execute"), false);
        assert.deepStrictEqual(Object.keys(modelTool).sort(), [
            "description",
            "inputSchema",
            "name",
        ]);
    }
});

test("multiple heterogeneous ToolDefinitions can convert to ModelTool[]", () => {
    const stringSchema = z.object({ text: z.string() });
    const numberSchema = z.object({ limit: z.number().optional() });
    const booleanSchema = z.object({ flag: z.boolean(), tags: z.array(z.string()) });

    const tool1: ToolDefinition<typeof stringSchema> = {
        name: "tool_alpha",
        description: "Alpha tool",
        inputSchema: stringSchema,
        execute: async (input) => ({ content: input.text }),
    };

    const tool2: ToolDefinition<typeof numberSchema> = {
        name: "tool_beta",
        description: "Beta tool",
        inputSchema: numberSchema,
        execute: async (input) => ({ content: String(input.limit ?? 0) }),
    };

    const tool3: ToolDefinition<typeof booleanSchema> = {
        name: "tool_gamma",
        description: "Gamma tool",
        inputSchema: booleanSchema,
        execute: async (input) => ({ content: `${input.flag}:${input.tags.length}` }),
    };

    const repoTools = createRepositoryTools("/dummy/root");
    const allTools = [...repoTools, tool1, tool2, tool3];

    const modelTools = toModelTools(allTools);

    assert.strictEqual(modelTools.length, allTools.length);
    assert.deepStrictEqual(
        modelTools.map((t) => t.name),
        allTools.map((t) => t.name),
    );

    for (const modelTool of modelTools) {
        assert.strictEqual(typeof modelTool.name, "string");
        assert.strictEqual(typeof modelTool.description, "string");
        assert.strictEqual(typeof modelTool.inputSchema, "object");
        assert.strictEqual("execute" in modelTool, false);
    }
});

test("ModelTool conversion does not change runtime ToolDefinition behavior", async () => {
    let callCount = 0;
    const testSchema = z.object({
        message: z.string().min(2),
    });

    const runtimeTool: ToolDefinition<typeof testSchema> = {
        name: "echo_tool",
        description: "Echoes a message",
        inputSchema: testSchema,
        execute: async (input) => {
            callCount++;
            return { content: `Echo: ${input.message}` };
        },
    };

    // Pre-conversion runtime behavior
    const beforeResult = await executeTool(runtimeTool, { message: "hello" });
    assert.strictEqual(beforeResult.content, "Echo: hello");
    assert.strictEqual(callCount, 1);

    // Convert to ModelTool
    const modelTool = toModelTool(runtimeTool);
    assert.strictEqual(modelTool.name, "echo_tool");

    // Post-conversion runtime behavior on the same original tool definition
    const afterResult = await executeTool(runtimeTool, { message: "world" });
    assert.strictEqual(afterResult.content, "Echo: world");
    assert.strictEqual(callCount, 2);

    // Validation rejection still functions unchanged
    await assert.rejects(
        () => executeTool(runtimeTool, { message: "x" }),
        (err: Error) => err.name === "ZodError",
    );
    assert.strictEqual(callCount, 2);

    // Direct execute method still functions unchanged
    const directResult = await runtimeTool.execute({ message: "direct" });
    assert.strictEqual(directResult.content, "Echo: direct");
    assert.strictEqual(callCount, 3);
});
