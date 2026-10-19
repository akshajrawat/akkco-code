import type { ModelProvider, ModelRequest } from "@akkco/models";
import {
    prepareBoundedModelRequest,
    type PrepareBoundedModelRequestOptions,
} from "./request-preparer.js";

export type BoundedModelProviderOptions = Omit<PrepareBoundedModelRequestOptions, "request">;

/**
 * Decorator that wraps a ModelProvider with authoritative preflight budget enforcement,
 * ensuring outbound requests never exceed configured model limits.
 */
export class BoundedModelProvider implements ModelProvider {
    readonly id: string;

    constructor(
        private readonly provider: ModelProvider,
        private readonly options?: BoundedModelProviderOptions,
    ) {
        this.id = `${provider.id}-bounded`;
    }

    stream = (request: ModelRequest) => {
        const prepared = prepareBoundedModelRequest({
            request,
            budget: this.options?.budget,
            profile: request.profile ?? this.options?.profile,
            maxToolOutputTokens: this.options?.maxToolOutputTokens,
        });

        return this.provider.stream(prepared);
    };
}

/**
 * Creates a bounded model provider wrapper that applies preflight budget enforcement.
 */
export const createBoundedModelProvider = (
    provider: ModelProvider,
    options?: BoundedModelProviderOptions,
): ModelProvider => new BoundedModelProvider(provider, options);
