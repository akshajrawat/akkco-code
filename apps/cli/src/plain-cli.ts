import { stdin, stdout, stderr } from "node:process";
import { createInterface } from "node:readline";
import { toolArguments, toolStatusLabel } from "./presentation.js";
import type { CliController } from "./state/cli-controller.js";
import type { CliMetadata } from "./state/types.js";

export const runPlainCli = async (controller: CliController, metadata: CliMetadata) => {
    const readline = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
    const queue: string[] = [];

    let processing = false;
    let ended = false;
    let finish = () => {};

    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });

    const unsubscribe = controller.onEvent((event) => {
        if (event.type === "exit") {
            finish();
        } else if (event.type === "idle") {
            if (!ended) {
                stdout.write("> ");
            }
        } else if (event.type === "text") {
            stdout.write(event.content);
        } else {
            const { item } = event;

            if (item.type === "message") {
                if (item.role === "assistant") {
                    stdout.write("\n\n");
                }
            } else if (item.type === "notice") {
                const targetStream = item.kind === "error" ? stderr : stdout;
                targetStream.write(`${item.content}\n\n`);
            } else if (item.type === "tools") {
                stdout.write(item.tools.length ? "Available tools:\n" : "No tools available.\n");
                for (const tool of item.tools) {
                    stdout.write(`- ${tool.name}: ${tool.description}\n`);
                }
                stdout.write("\n");
            } else {
                const execution = item.execution;
                stdout.write(
                    `Tool: ${execution.toolName}\n  args: ${toolArguments(execution.arguments)}\n  ${toolStatusLabel(execution)}\n`,
                );

                if (execution.showResult && execution.result !== undefined) {
                    stdout.write(`${execution.result}\n`);
                }

                if (execution.error) {
                    stderr.write(`Error: ${execution.error}\n`);
                }

                stdout.write("\n");
            }
        }
    });

    const drain = async () => {
        if (processing) {
            return;
        }

        processing = true;

        try {
            while (queue.length && !controller.getSnapshot().exited) {
                await controller.submit(queue.shift()!);
            }
        } finally {
            processing = false;

            if (ended && !controller.getSnapshot().exited) {
                controller.exit(false);
            }
        }
    };

    readline.on("line", (line) => {
        queue.push(line);
        void drain();
    });

    readline.on("close", () => {
        ended = true;
        void drain();
    });

    stdout.write(
        `Akkco Code v${metadata.version}\n${metadata.provider} · ${metadata.model} · ${metadata.toolMode}\nDirectory: ${metadata.cwd}\n\n> `,
    );

    try {
        await finished;
    } finally {
        unsubscribe();
        readline.close();
        stdin.pause();
    }
};
