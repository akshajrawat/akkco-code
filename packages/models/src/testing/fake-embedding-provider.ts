import type { EmbeddingProvider } from "../contracts/embedding.js";

export interface FakeEmbeddingProviderOptions {
    id?: string;
    model?: string;
    dimensions?: number;
    customVectors?: Record<string, number[]>;
    semanticRules?: Array<{
        pattern: RegExp | string;
        vector: number[];
    }>;
}

const generateDeterministicVector = (
    text: string,
    dimensions: number,
    reservedDimensions?: Set<number>,
): number[] => {
    const vector = new Array<number>(dimensions).fill(0);
    const availableDims: number[] = [];
    for (let d = 0; d < dimensions; d++) {
        if (!reservedDimensions || !reservedDimensions.has(d)) {
            availableDims.push(d);
        }
    }
    const numDims = availableDims.length > 0 ? availableDims.length : dimensions;

    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        const idx = (i + code) % numDims;
        const dim = availableDims.length > 0 ? availableDims[idx] : idx;
        const sign = (code & 1) === 0 ? 1 : -1;
        vector[dim] += sign * ((code % 31) + 1);
    }

    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
        norm += vector[i] * vector[i];
    }

    if (norm === 0) {
        const fallbackDim = availableDims.length > 0 ? availableDims[0] : 0;
        vector[fallbackDim] = 1;
        norm = 1;
    }

    const magnitude = Math.sqrt(norm);
    for (let i = 0; i < dimensions; i++) {
        vector[i] = Number((vector[i] / magnitude).toFixed(6));
    }

    return vector;
};

export class DeterministicFakeEmbeddingProvider implements EmbeddingProvider {
    readonly id: string;
    readonly model: string;
    readonly dimensions: number;
    private readonly customVectors: Record<string, number[]>;
    private readonly semanticRules: Array<{ pattern: RegExp | string; vector: number[] }>;
    private readonly reservedDimensions = new Set<number>();

    constructor(options?: FakeEmbeddingProviderOptions) {
        this.id = options?.id ?? "fake-embedding";
        this.model = options?.model ?? "fake-embedding-model";
        this.dimensions = options?.dimensions ?? 16;
        this.customVectors = { ...(options?.customVectors ?? {}) };
        this.semanticRules = [...(options?.semanticRules ?? [])];

        for (const rule of this.semanticRules) {
            for (let d = 0; d < rule.vector.length; d++) {
                if (rule.vector[d] !== 0) {
                    this.reservedDimensions.add(d);
                }
            }
        }

        for (const [key, vec] of Object.entries(this.customVectors)) {
            if (vec.length !== this.dimensions) {
                throw new Error(
                    `Custom vector for "${key}" has dimension ${vec.length}, expected ${this.dimensions}`,
                );
            }
            for (const val of vec) {
                if (!Number.isFinite(val)) {
                    throw new Error(`Custom vector for "${key}" contains non-finite value`);
                }
            }
        }
    }

    embed = async (inputs: readonly string[], signal?: AbortSignal): Promise<number[][]> => {
        if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        const results: number[][] = [];

        for (const input of inputs) {
            if (signal?.aborted) {
                throw new DOMException("The operation was aborted.", "AbortError");
            }

            if (this.customVectors[input]) {
                results.push([...this.customVectors[input]]);
                continue;
            }

            const matchedRule = this.semanticRules.find(({ pattern }) =>
                typeof pattern === "string" ? input.includes(pattern) : pattern.test(input),
            );

            if (matchedRule) {
                if (matchedRule.vector.length !== this.dimensions) {
                    throw new Error(
                        `Rule vector has dimension ${matchedRule.vector.length}, expected ${this.dimensions}`,
                    );
                }
                results.push([...matchedRule.vector]);
                continue;
            }

            results.push(
                generateDeterministicVector(input, this.dimensions, this.reservedDimensions),
            );
        }

        return results;
    };
}
