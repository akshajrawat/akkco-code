import type {
    ModelEvent,
    ModelMessage,
    ModelProvider,
    ModelRequest,
    ModelToolCallEvent,
} from "@akkco/models";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DeterministicTestProvider implements ModelProvider {
    readonly id = "deterministic-test-provider";

    stream = (request: ModelRequest): AsyncIterable<ModelEvent> => {
        const lastUserMessage = request.items
            .filter((item): item is ModelMessage => item.type === "message" && item.role === "user")
            .at(-1);

        const content = lastUserMessage?.content?.trim() ?? "";
        const hasToolResult = request.items.some((item) => item.type === "tool_result");

        return {
            async *[Symbol.asyncIterator]() {
                if (content.includes("__TEST_WAIT__") || content.includes("__TEST_LONG_WAIT__")) {
                    yield {
                        type: "text",
                        content: content.includes("__TEST_LONG_WAIT__")
                            ? Array.from(
                                  { length: 35 },
                                  (_, index) => `Live line ${index + 1}`,
                              ).join("\n")
                            : "Starting wait task...",
                    } satisfies ModelEvent;

                    if (request.signal) {
                        await new Promise<void>((resolve) => {
                            if (request.signal?.aborted) {
                                resolve();
                                return;
                            }
                            request.signal?.addEventListener("abort", () => resolve(), {
                                once: true,
                            });
                        });
                    }
                    return;
                }

                if (content.includes("__TEST_TOOL__")) {
                    if (!hasToolResult) {
                        yield {
                            type: "tool_call",
                            id: "call_test_list",
                            name: "list_files",
                            arguments: { path: "." },
                        } satisfies ModelToolCallEvent;
                        return;
                    }

                    yield {
                        type: "text",
                        content: "Completed repository file listing.",
                    } satisfies ModelEvent;
                    return;
                }

                if (content.includes("__TEST_LONG__")) {
                    for (let i = 1; i <= 35; i++) {
                        if (request.signal?.aborted) {
                            return;
                        }
                        yield {
                            type: "text",
                            content: `Line ${i.toString().padStart(2, "0")}: Deterministic history output for scrolling test.\n`,
                        } satisfies ModelEvent;
                        await delay(5);
                    }
                    return;
                }

                // Default text streaming
                const chunks = ["Hello", " from", " Akkco", " deterministic", " provider."];
                for (const chunk of chunks) {
                    if (request.signal?.aborted) {
                        return;
                    }
                    yield {
                        type: "text",
                        content: chunk,
                    } satisfies ModelEvent;
                    await delay(10);
                }
            },
        };
    };
}

export const createDeterministicTestProvider = (): ModelProvider => new DeterministicTestProvider();
