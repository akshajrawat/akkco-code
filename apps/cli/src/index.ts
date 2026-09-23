import { createAkkcoRuntime, Session } from "@akkco/core";
import { OpenAICompatibleProvider } from "@akkco/providers";
import process, { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const main = async () => {
    const provider = new OpenAICompatibleProvider({
        baseUrl: process.env.AKKCO_BASE_URL ?? "http://localhost:11434/v1",
        model: process.env.AKKCO_MODEL ?? "qwen2.5-coder:3b",
        apiKey: process.env.AKKCO_API_KEY,
    });
    const runtime = createAkkcoRuntime(provider);
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

            const controller = new AbortController();
            const onSigint = () => {
                controller.abort();
            };
            readline.on("SIGINT", onSigint);
            process.on("SIGINT", onSigint);

            try {
                for await (const event of session.send(input, controller.signal)) {
                    stdout.write(event.content);
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