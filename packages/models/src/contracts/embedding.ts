export interface EmbeddingIdentity {
    readonly provider: string;
    readonly model: string;
    readonly dimensions?: number;
}

export interface EmbeddingProvider {
    readonly id: string;
    readonly model: string;

    embed(inputs: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}
