import { createAkkcoRuntime, Session, type RuntimeToolHost } from "@akkco/core";
import { OpenAICompatibleProvider } from "@akkco/providers";
import { createRepositoryTools, createToolRegistry, toModelTools } from "@akkco/tools";
import process, { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const main = async () => {
    const provider = new OpenAICompatibleProvider({
        baseUrl: process.env.AKKCO_BASE_URL ?? "http://localhost:11434/v1",
        model: process.env.AKKCO_MODEL ?? "qwen2.5-coder:3b",
        apiKey: process.env.AKKCO_API_KEY,
    });
    const toolRegistry = createToolRegistry(createRepositoryTools(process.cwd()));
    const toolHost: RuntimeToolHost = {
        get tools() {
            return toModelTools(toolRegistry.list());
        },
        execute: async (name: string, input: unknown) => {
            return toolRegistry.execute(name, input);
        },
    };
    const runtime = createAkkcoRuntime(provider, toolHost);
    const session = new Session(runtime);

    const readline = createInterface({ input: stdin, output: stdout });

    console.log("Akkco Code\n");

    try {
        while (true) {
            const input = await readline.question("> ").catch(() => null);
            if (input === null) {
                break;
            }

            const trimmed = input.trim();
            if (trimmed === "") {
                continue;
            }

            if (trimmed === "/exit") {
                console.log("Goodbye.");
                break;
            }

            if (trimmed === "/clear") {
                session.clear();
                console.log("Conversation cleared.\n");
                continue;
            }

            if (trimmed === "/tools") {
                const tools = toolRegistry.list();
                if (tools.length === 0) {
                    console.log("No tools available.\n");
                } else {
                    console.log("Available tools:");
                    for (const tool of tools) {
                        console.log(`- ${tool.name}: ${tool.description}`);
                    }
                    console.log();
                }
                continue;
            }

            if (trimmed === "/tool" || trimmed.startsWith("/tool ")) {
                const args = trimmed.slice(5).trim();
                if (!args) {
                    console.error("Usage: /tool <name> [json]\n");
                    continue;
                }

                const firstSpace = args.indexOf(" ");
                const toolName = firstSpace === -1 ? args : args.slice(0, firstSpace);
                const rawJson = firstSpace === -1 ? "{}" : args.slice(firstSpace + 1).trim();

                let toolInput: unknown;
                try {
                    toolInput = JSON.parse(rawJson === "" ? "{}" : rawJson);
                } catch {
                    console.error("Error: Invalid JSON input for tool.\n");
                    continue;
                }

                try {
                    const result = await toolRegistry.execute(toolName, toolInput);
                    console.log(`${result.content}\n`);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error(`Error: ${message}\n`);
                }
                continue;
            }

            const controller = new AbortController();
            const onSigint = () => {
                controller.abort();
            };
            readline.on("SIGINT", onSigint);
            process.on("SIGINT", onSigint);

            try {
                for await (const event of session.send(input, controller.signal)) {
                    if (event.type === "text") {
                        stdout.write(event.content);
                    }
                }
                stdout.write("\n\n");
            } catch (error) {
                stdout.write("\n");
                if (controller.signal.aborted) {
                    console.log("Generation cancelled.\n");
                } else {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error(`Error: ${message}\n`);
                }
            } finally {
                readline.off("SIGINT", onSigint);
                process.off("SIGINT", onSigint);
            }
        }
    } finally {
        readline.close();
    }
};

main();
