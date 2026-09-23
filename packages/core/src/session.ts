import type { ModelMessage } from "@akkco/models";
import type { AkkcoRuntime } from "./runtime.js";

export class Session {
    private readonly _messages: ModelMessage[];
    private _isRunning = false;

    constructor(private readonly runtime: AkkcoRuntime, initialMessages: ModelMessage[] = []) {
        this._messages = initialMessages.map((message) => ({ ...message }));
    }

    get messages() {
        return this._messages.map((message) => ({ ...message }));
    }

    get isRunning() {
        return this._isRunning;
    }

    send = (input: string, signal?: AbortSignal) => {
        const runtime = this.runtime;
        const internalMessages = this._messages;
        const self = this;

        return {
            async *[Symbol.asyncIterator]() {
                if (self._isRunning) {
                    throw new Error("A generation is already in progress for this session");
                }
                self._isRunning = true;

                try {
                    internalMessages.push({ role: "user", content: input });
                    const messages = internalMessages.map((message) => ({ ...message }));
                    let assistantText = "";
                    for await (const event of runtime.run({ messages, signal })) {
                        assistantText += event.content;
                        yield event;
                    }
                    internalMessages.push({ role: "assistant", content: assistantText });
                } finally {
                    self._isRunning = false;
                }
            },
        };
    };

    clear = () => {
        if (this._isRunning) {
            throw new Error("Cannot clear session while generation is in progress");
        }
        this._messages.length = 0;
    };
}

export const createAkkcoSession = (runtime: AkkcoRuntime, initialMessages: ModelMessage[] = []) =>
    new Session(runtime, initialMessages);
