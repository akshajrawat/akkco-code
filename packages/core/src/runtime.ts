import type { ModelProvider, ModelRequest } from "@akkco/models";

export const createAkkcoRuntime = (provider: ModelProvider) => {
    const run = (request: ModelRequest) => {
        return provider.stream(request);
    };

    return { run };
};

export type AkkcoRuntime = ReturnType<typeof createAkkcoRuntime>;