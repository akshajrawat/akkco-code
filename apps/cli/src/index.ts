import { createAkkcoRuntime } from "@akkco/core";
import { FakeModelProvider, ModelRequest } from "@akkco/models";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const main = async () => {
    const provider = new FakeModelProvider();
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