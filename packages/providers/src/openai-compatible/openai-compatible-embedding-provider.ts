import type { EmbeddingProvider } from "@akkco/models";

export interface OpenAICompatibleEmbeddingConfig {
    baseUrl: string;
    model: string;
    apiKey?: string;
    dimensions?: number;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
    readonly id = "openai-compatible";
    readonly model: string;
    private readonly baseUrl: string;
    private readonly apiKey?: string;
    readonly dimensions?: number;

    constructor(config: OpenAICompatibleEmbeddingConfig) {
        this.baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
        this.model = config.model;
        this.apiKey = config.apiKey;
        this.dimensions = config.dimensions;
    }

    embed = async (inputs: readonly string[], signal?: AbortSignal): Promise<number[][]> => {
        if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        if (inputs.length === 0) {
            return [];
        }

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (this.apiKey) {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        }

        const body: Record<string, unknown> = {
            model: this.model,
            input: inputs,
        };
        if (this.dimensions !== undefined) {
            body.dimensions = this.dimensions;
        }

        const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(
                `OpenAI embedding request failed with status ${response.status}: ${errorText}`,
            );
        }

        let json: unknown;
        try {
            json = await response.json();
        } catch (error) {
            throw new Error(
                `Failed to parse embedding response JSON: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        if (
            !json ||
            typeof json !== "object" ||
            !("data" in json) ||
            !Array.isArray((json as { data: unknown }).data)
        ) {
            throw new Error("Malformed OpenAI embedding response: missing or invalid 'data' array");
        }

        const data = (json as { data: Array<{ index?: number; embedding?: unknown }> }).data;
        if (data.length !== inputs.length) {
            throw new Error(
                `OpenAI embedding response count mismatch: expected ${inputs.length}, got ${data.length}`,
            );
        }

        const sorted = [...data].sort((a, b) => {
            const aIdx = typeof a.index === "number" ? a.index : 0;
            const bIdx = typeof b.index === "number" ? b.index : 0;
            return aIdx - bIdx;
        });

        const results: number[][] = [];
        let expectedDim: number | undefined = this.dimensions;

        for (let i = 0; i < sorted.length; i++) {
            const item = sorted[i];
            if (!item || !Array.isArray(item.embedding)) {
                throw new Error(
                    `Malformed OpenAI embedding response item at index ${i}: missing or invalid 'embedding' array`,
                );
            }

            const vec = item.embedding;
            if (vec.length === 0) {
                throw new Error(`Embedding vector at index ${i} is empty`);
            }

            if (expectedDim === undefined) {
                expectedDim = vec.length;
            } else if (vec.length !== expectedDim) {
                throw new Error(
                    `Inconsistent embedding dimensions: expected ${expectedDim}, got ${vec.length} at index ${i}`,
                );
            }

            for (let j = 0; j < vec.length; j++) {
                const val = vec[j];
                if (typeof val !== "number" || !Number.isFinite(val)) {
                    throw new Error(
                        `Non-finite value in embedding vector at index ${i}, dimension ${j}`,
                    );
                }
            }

            results.push(vec as number[]);
        }

        return results;
    };
}
