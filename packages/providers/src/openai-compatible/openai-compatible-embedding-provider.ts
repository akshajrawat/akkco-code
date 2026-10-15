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

        const data = (json as { data: Array<{ index?: unknown; embedding?: unknown }> }).data;
        if (data.length !== inputs.length) {
            throw new Error(
                `OpenAI embedding response count mismatch: expected ${inputs.length}, got ${data.length}`,
            );
        }

        const seenIndices = new Set<number>();
        const mappedResults: (number[] | undefined)[] = new Array(inputs.length);
        let expectedDim: number | undefined = this.dimensions;

        for (let i = 0; i < data.length; i++) {
            const item = data[i];
            if (!item || typeof item !== "object") {
                throw new Error(
                    `Malformed OpenAI embedding response item at position ${i}: not an object`,
                );
            }

            const idx = item.index;
            if (typeof idx !== "number" || !Number.isInteger(idx)) {
                throw new Error(
                    `Malformed OpenAI embedding response item at position ${i}: index must be an integer, got ${String(idx)}`,
                );
            }

            if (idx < 0 || idx >= inputs.length) {
                throw new Error(
                    `OpenAI embedding response item at position ${i} has out-of-range index ${idx} (expected 0 <= index < ${inputs.length})`,
                );
            }

            if (seenIndices.has(idx)) {
                throw new Error(`OpenAI embedding response contains duplicate index ${idx}`);
            }
            seenIndices.add(idx);

            if (!Array.isArray(item.embedding)) {
                throw new Error(
                    `Malformed OpenAI embedding response item with index ${idx}: missing or invalid 'embedding' array`,
                );
            }

            const vec = item.embedding;
            if (vec.length === 0) {
                throw new Error(`Embedding vector at index ${idx} is empty`);
            }

            if (expectedDim === undefined) {
                expectedDim = vec.length;
            } else if (vec.length !== expectedDim) {
                throw new Error(
                    `Inconsistent embedding dimensions: expected ${expectedDim}, got ${vec.length} at index ${idx}`,
                );
            }

            for (let j = 0; j < vec.length; j++) {
                const val = vec[j];
                if (typeof val !== "number" || !Number.isFinite(val)) {
                    throw new Error(
                        `Non-finite value in embedding vector at index ${idx}, dimension ${j}`,
                    );
                }
            }

            mappedResults[idx] = vec as number[];
        }

        for (let i = 0; i < inputs.length; i++) {
            if (mappedResults[i] === undefined) {
                throw new Error(`Missing embedding vector for input index ${i}`);
            }
        }

        return mappedResults as number[][];
    };
}
