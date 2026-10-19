import type { ModelProvider, ModelRequest } from "@akkco/models";
import {
    prepareBoundedModelRequest,
    type PrepareBoundedModelRequestOptions,
} from "./request-preparer.js";

export const BOUNDED_PROVIDER_SYMBOL = Symbol.for("akkco.bounded_provider");

export type BoundedModelProviderOptions = Omit<PrepareBoundedModelRequestOptions, "request">;

/**
 * Decorator that wraps a ModelProvider with authoritative preflight budget enforcement,
 * ensuring outbound requests never exceed configured model limits.
 */
export class BoundedModelProvider implements ModelProvider {
    readonly id: string;
    readonly [BOUNDED_PROVIDER_SYMBOL] = true;

    constructor(
        readonly provider: ModelProvider,
        readonly options?: BoundedModelProviderOptions,
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
 * Type-guard checking if a provider instance already applies authoritative preflight bounds.
 */
export const isBoundedModelProvider = (provider: unknown): provider is BoundedModelProvider => {
    return Boolean(
        provider &&
        typeof provider === "object" &&
        ((provider as any) instanceof BoundedModelProvider ||
            (provider as any)[BOUNDED_PROVIDER_SYMBOL] === true),
    );
};

/**
 * Creates a bounded model provider wrapper that applies preflight budget enforcement.
 */
export const createBoundedModelProvider = (
    provider: ModelProvider,
    options?: BoundedModelProviderOptions,
): ModelProvider => new BoundedModelProvider(provider, options);

/**
 * Ensures a provider is wrapped with authoritative final preflight budget enforcement.
 * If the provider is already bounded, it is returned unchanged.
 * If the provider is a delegating wrapper (such as TextToolCompatibilityProvider),
 * the inner provider is bounded so protocol transformations (e.g. XML tool schemas,
 * repair instructions) are validated at preflight.
 */
export const ensureBoundedProvider = (
    provider: ModelProvider,
    options?: BoundedModelProviderOptions,
): ModelProvider => {
    if (isBoundedModelProvider(provider)) {
        return provider;
    }

    if (
        "provider" in provider &&
        typeof (provider as any).provider === "object" &&
        typeof (provider as any).provider?.stream === "function"
    ) {
        const delegating = provider as { provider: ModelProvider; options?: unknown };
        if (isBoundedModelProvider(delegating.provider)) {
            return provider;
        }
        const boundedInner = ensureBoundedProvider(delegating.provider, options);
        return new (
            delegating.constructor as new (p: ModelProvider, opt?: unknown) => ModelProvider
        )(boundedInner, delegating.options);
    }

    return new BoundedModelProvider(provider, options);
};
