import type { ModelEvent, ModelProvider, ModelRequest } from "@akkco/models";

export interface OpenAICompatibleConfig {
    baseUrl: string;
    model: string;
    apiKey?: string;
}

export class OpenAICompatibleProvider implements ModelProvider {
    readonly id = "openai-compatible";
    private readonly config: OpenAICompatibleConfig;

    constructor(config: OpenAICompatibleConfig) {
        this.config = {
            ...config,
            baseUrl: config.baseUrl.trim(),
        };
    }

    stream = (request: ModelRequest) => {
        const { baseUrl, model, apiKey } = this.config;

        return {
            async *[Symbol.asyncIterator]() {
                const headers = {
                    "Content-Type": "application/json",
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                };

                const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        model,
                        messages: request.messages,
                        stream: true,
                    }),
                    signal: request.signal,
                });

                if (!response.ok) {
                    const errorText = await response.text().catch(() => "");
                    throw new Error(`OpenAI request failed with status ${response.status}: ${errorText}`);
                }

                if (!response.body) {
                    throw new Error("Response body is empty or unavailable");
                }

                const decoder = new TextDecoder();
                let buffer = "";

                const parseLine = (rawLine: string) => {
                    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
                    if (!line.startsWith("data:")) {
                        return null;
                    }

                    const data = line.slice(5).trim();
                    if (data === "[DONE]") {
                        return { done: true as const };
                    }

                    if (!data) {
                        return null;
                    }

                    let json: any;
                    try {
                        json = JSON.parse(data);
                    } catch {
                        // ignore malformed JSON lines
                        return null;
                    }

                    if (json.error) {
                        const message = typeof json.error === "object" && json.error?.message
                            ? json.error.message
                            : (typeof json.error === "string" ? json.error : JSON.stringify(json.error));
                        throw new Error(message);
                    }

                    const content = json.choices?.[0]?.delta?.content;
                    if (typeof content === "string" && content) {
                        return { done: false as const, content };
                    }

                    return null;
                };

                for await (const chunk of response.body) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    for (const rawLine of lines) {
                        const parsed = parseLine(rawLine);
                        if (!parsed) {
                            continue;
                        }
                        if (parsed.done) {
                            return;
                        }
                        yield {
                            type: "text",
                            content: parsed.content,
                        } satisfies ModelEvent;
                    }
                }

                buffer += decoder.decode();
                if (buffer.length > 0) {
                    const parsed = parseLine(buffer);
                    if (parsed && !parsed.done) {
                        yield {
                            type: "text",
                            content: parsed.content,
                        } satisfies ModelEvent;
                    }
                }
            },
        };
    };
}
