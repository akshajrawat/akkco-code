import type { ModelProvider, ModelRequest } from "@akkco/models";
import { mapModelRequestToOpenAIPayload } from "./request-mapper.js";
import { parseOpenAIEventStream } from "./stream-parser.js";

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

                const payload = mapModelRequestToOpenAIPayload(request, model);

                const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(payload),
                    signal: request.signal,
                });

                if (!response.ok) {
                    const errorText = await response.text().catch(() => "");
                    throw new Error(`OpenAI request failed with status ${response.status}: ${errorText}`);
                }

                if (!response.body) {
                    throw new Error("Response body is empty or unavailable");
                }

                yield* parseOpenAIEventStream(response.body, request.signal);
            },
        };
    };
}
