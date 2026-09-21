import { createAkkcoRuntime } from "@akkco/core";
import type { ModelRequest } from "@akkco/models";
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

    const readline = createInterface({ input: stdin, output: stdout });

    console.log('\nAkkco Code\n');

    const input = await readline.question('> ');

    const request: ModelRequest = {
        messages: [
            {
                role: "user",
                content: input,
            },
        ],
    };

    for await (const event of runtime.run(request)) {
        stdout.write(event.content);
    }

    stdout.write('\n');
    readline.close();
};

main();