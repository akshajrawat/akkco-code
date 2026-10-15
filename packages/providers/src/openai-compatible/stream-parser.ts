import type { ModelEvent, ModelTextEvent, ModelToolCallEvent } from "@akkco/models";

interface InProgressToolCall {
    id: string;
    name: string;
    argumentsBuffer: string;
    emitted: boolean;
}

export const parseOpenAIEventStream = async function* (
    body: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
): AsyncGenerator<ModelEvent, void, unknown> {
    const decoder = new TextDecoder();
    let buffer = "";

    const inProgressToolCalls = new Map<number | string, InProgressToolCall>();
    let isDone = false;

    const flushToolCalls = function* (): Generator<ModelToolCallEvent> {
        for (const call of inProgressToolCalls.values()) {
            if (call.emitted) {
                continue;
            }

            if (!call.id && !call.name && !call.argumentsBuffer) {
                continue;
            }

            const rawArgs = call.argumentsBuffer.trim();
            let parsedArgs: unknown;
            try {
                parsedArgs = rawArgs === "" ? {} : JSON.parse(rawArgs);
            } catch (error: any) {
                throw new Error(
                    `Failed to parse tool call arguments for "${call.name || call.id}": ${error?.message ?? "Invalid JSON"}`,
                );
            }

            call.emitted = true;
            yield {
                type: "tool_call",
                id: call.id,
                name: call.name,
                arguments: parsedArgs,
            };
        }
    };

    const handleLine = function* (rawLine: string): Generator<ModelEvent> {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line.startsWith("data:")) {
            return;
        }

        const data = line.slice(5).trim();
        if (data === "[DONE]") {
            isDone = true;
            yield* flushToolCalls();
            return;
        }

        if (!data) {
            return;
        }

        let json: any;
        try {
            json = JSON.parse(data);
        } catch {
            return;
        }

        if (json.error) {
            const message =
                typeof json.error === "object" && json.error?.message
                    ? json.error.message
                    : typeof json.error === "string"
                      ? json.error
                      : JSON.stringify(json.error);
            throw new Error(message);
        }

        const choice = json.choices?.[0];
        if (!choice) {
            return;
        }

        const content = choice.delta?.content;
        if (typeof content === "string" && content.length > 0) {
            yield {
                type: "text",
                content,
            } satisfies ModelTextEvent;
        }

        if (Array.isArray(choice.delta?.tool_calls)) {
            for (const deltaCall of choice.delta.tool_calls) {
                const key = deltaCall.index ?? deltaCall.id ?? 0;
                let call = inProgressToolCalls.get(key);
                if (!call) {
                    call = {
                        id: deltaCall.id ?? "",
                        name: deltaCall.function?.name ?? "",
                        argumentsBuffer: deltaCall.function?.arguments ?? "",
                        emitted: false,
                    };
                    inProgressToolCalls.set(key, call);
                } else {
                    if (deltaCall.id) {
                        if (!call.id) {
                            call.id = deltaCall.id;
                        } else if (!call.id.includes(deltaCall.id)) {
                            call.id += deltaCall.id;
                        }
                    }
                    if (deltaCall.function?.name) {
                        call.name += deltaCall.function.name;
                    }
                    if (deltaCall.function?.arguments) {
                        call.argumentsBuffer += deltaCall.function.arguments;
                    }
                }
            }
        }

        if (choice.finish_reason) {
            yield* flushToolCalls();
        }
    };

    const throwIfAborted = () => {
        if (signal?.aborted) {
            if (typeof signal.throwIfAborted === "function") {
                signal.throwIfAborted();
            }
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            throw err;
        }
    };

    for await (const chunk of body) {
        throwIfAborted();

        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
            throwIfAborted();

            for (const event of handleLine(rawLine)) {
                yield event;
            }

            if (isDone) {
                throwIfAborted();
                return;
            }
        }
    }

    throwIfAborted();

    buffer += decoder.decode();
    if (buffer.length > 0) {
        for (const event of handleLine(buffer)) {
            yield event;
        }
    }
    if (!isDone) {
        yield* flushToolCalls();
    }
    throwIfAborted();
};
