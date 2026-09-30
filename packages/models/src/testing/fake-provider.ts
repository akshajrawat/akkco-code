import type { ModelEvent } from "../contracts/events.js";
import type { ModelMessage } from "../contracts/items.js";
import type { ModelProvider } from "../contracts/provider.js";
import type { ModelRequest } from "../contracts/request.js";

export class FakeModelProvider implements ModelProvider {
    readonly id = "fake";

    stream = (request: ModelRequest) => {
        const lastMessage = request.items
            .filter((item): item is ModelMessage => item.type === "message")
            .at(-1);
        const text = `Fake response to ${lastMessage?.content ?? ""}`;

        const chunks = text.split(" ");

        return {
            async *[Symbol.asyncIterator]() {
                for (const chunk of chunks) {
                    yield {
                        type: "text",
                        content: `${chunk} `,
                    } satisfies ModelEvent;
                }
            },
        };
    };
}
