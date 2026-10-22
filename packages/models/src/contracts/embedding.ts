export interface EmbeddingIdentity {
    readonly provider: string;
    readonly model: string;
    readonly dimensions?: number;
}

export interface EmbeddingOptions {
    readonly taskType?: string;
    readonly title?: string;
}

export interface EmbeddingProvider {
    readonly id: string;
    readonly model: string;
    readonly dimensions?: number;
    readonly timeoutMs?: number;

    embed(
        inputs: readonly string[],
        signal?: AbortSignal,
        options?: EmbeddingOptions,
    ): Promise<number[][]>;
}
