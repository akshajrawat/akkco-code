import type { ModelMessage } from "@akkco/models";
import type { AkkcoRuntime } from "./runtime.js";

export class Session {
    private readonly _messages: ModelMessage[];

    constructor(private readonly runtime: AkkcoRuntime, initialMessages: ModelMessage[] = []) {
        this._messages = initialMessages.map((message) => ({ ...message }));
    }

    get messages() {
        return this._messages.map((message) => ({ ...message }));
    }

    send = (input: string) => {
        this._messages.push({ role: "user", content: input });

        const runtime = this.runtime;
        const messages = [...this._messages];
        const internalMessages = this._messages;

        return {
            async *[Symbol.asyncIterator]() {
                let assistantText = "";
                for await (const event of runtime.run({ messages })) {
                    assistantText += event.content;
                    yield event;
                }
                internalMessages.push({ role: "assistant", content: assistantText });
            },
        };
    };

    clear = () => {
        this._messages.length = 0;
    };
}

export const createAkkcoSession = (runtime: AkkcoRuntime, initialMessages: ModelMessage[] = []) =>
    new Session(runtime, initialMessages);
