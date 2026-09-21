import type { ModelProvider } from "../provider.js";
import type { ModelEvent, ModelRequest } from "../types.js";

export class FakeModelProvider implements ModelProvider {

    readonly id = 'fake';

    stream = (request: ModelRequest) => {
        const text = `Fake response to ${request.messages.at(-1)?.content ?? ""}`

        const chunks = text.split(" ");

        return {
            async *[Symbol.asyncIterator]() {
                for (const chunk of chunks) {
                    yield {
                        type: "text",
                        content: `${chunk} `,
                    } satisfies ModelEvent;
                }
            }
        }
    }
}