import type {
    ModelItem,
    ModelMessage,
    ModelProfile,
    ModelRequest,
    ModelTool,
    ModelToolResult,
} from "@akkco/models";
import { type ContextBudget, DEFAULT_CONTEXT_BUDGET, validateContextBudget } from "./budget.js";
import { estimateModelItemTokens, estimateTokens } from "./token-estimator.js";

/**
 * Thrown when mandatory request elements or active tool results exceed the
 * available context budget, failing closed before calling the model provider.
 */
export class ContextBudgetOverflowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ContextBudgetOverflowError";
    }
}

export interface PrepareBoundedModelRequestOptions {
    readonly request: ModelRequest;
    readonly budget?: ContextBudget;
    readonly profile?: ModelProfile;
    readonly maxToolOutputTokens?: number;
}

/**
 * Determines whether a system message is a mandatory policy item that must be preserved,
 * excluding optional instructions or untrusted context with non-policy provenance.
 */
export const isMandatoryPolicyItem = (item: ModelItem): boolean => {
    if (item.type !== "message" || item.role !== "system") {
        return false;
    }
    // Explicitly non-policy or marked with non-policy provenance is optional/untrusted, not mandatory policy
    if (item.isPolicy === false) {
        return false;
    }
    if (item.provenance && item.provenance.source !== "policy") {
        return false;
    }
    return true;
};

/**
 * Identifies privileged leading system items (policy and tool instructions)
 * that form the immutable prefix of a request and cannot be evicted.
 */
export const isPrivilegedPrefixItem = (item: ModelItem): boolean => {
    if (item.type !== "message" || item.role !== "system") {
        return false;
    }
    if (item.isToolInstruction === true) {
        return true;
    }
    return isMandatoryPolicyItem(item);
};

/**
 * Identifies genuine user prompt messages, distinguishing them from compatibility tool
 * result envelopes, repair instructions, and retrieved context documents that use the user role.
 */
export const isRealUserPromptItem = (item: ModelItem): boolean => {
    if (item.type !== "message" || item.role !== "user") {
        return false;
    }
    if (item.toolResultEnvelope !== undefined) {
        return false;
    }
    if (item.isRepairInstruction === true) {
        return false;
    }
    if (item.provenance?.source === "memory" || item.provenance?.source === "repository") {
        return false;
    }
    return true;
};

/**
 * Determines whether an item is a tool result, recognizing both native tool result items
 * and compatibility mode message envelopes.
 */
export const isToolResultItem = (item: ModelItem): boolean => {
    if (item.type === "tool_result") {
        return true;
    }
    if (item.type === "message" && item.toolResultEnvelope !== undefined) {
        return true;
    }
    return false;
};

export const estimateToolsTokens = (tools?: readonly ModelTool[], charsPerToken = 4): number => {
    if (!tools || tools.length === 0) {
        return 0;
    }
    return tools.reduce((sum, t) => {
        const schemaStr = JSON.stringify(t.inputSchema ?? {});
        return (
            sum +
            estimateTokens(t.name, charsPerToken) +
            estimateTokens(t.description, charsPerToken) +
            estimateTokens(schemaStr, charsPerToken) +
            8
        );
    }, 0);
};

export const estimateRequestTokens = (
    items: readonly ModelItem[],
    tools?: readonly ModelTool[],
    reservedOverheadTokens = 0,
    charsPerToken = 4,
): number => {
    const itemsTokens = items.reduce(
        (sum, it) => sum + estimateModelItemTokens(it, charsPerToken),
        0,
    );
    const toolsTokens = estimateToolsTokens(tools, charsPerToken);
    return itemsTokens + toolsTokens + reservedOverheadTokens;
};

export interface HistoricalGroup {
    items: ModelItem[];
    estimatedTokens: number;
}

/**
 * Groups historical items into atomic conversational units (turns, memory excerpts, or system messages)
 * so prior context can be packed or evicted without orphaning tool calls from their results.
 */
export const groupHistoricalItems = (
    items: readonly ModelItem[],
    charsPerToken = 4,
): HistoricalGroup[] => {
    const groups: HistoricalGroup[] = [];
    let currentGroup: ModelItem[] = [];

    const flushGroup = () => {
        if (currentGroup.length === 0) return;
        const tokens = currentGroup.reduce(
            (sum, it) => sum + estimateModelItemTokens(it, charsPerToken),
            0,
        );
        groups.push({ items: currentGroup, estimatedTokens: tokens });
        currentGroup = [];
    };

    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (
            item.type === "message" &&
            (item.provenance?.source === "memory" || item.provenance?.source === "repository")
        ) {
            flushGroup();
            const tokens = estimateModelItemTokens(item, charsPerToken);
            groups.push({ items: [item], estimatedTokens: tokens });
            continue;
        }

        if (item.type === "message" && item.role === "system") {
            flushGroup();
            const tokens = estimateModelItemTokens(item, charsPerToken);
            groups.push({ items: [item], estimatedTokens: tokens });
            continue;
        }

        if (isRealUserPromptItem(item)) {
            flushGroup();
            currentGroup.push(item);
            continue;
        }

        currentGroup.push(item);
    }

    flushGroup();
    return groups;
};

/**
 * Authoritative preflight preparation stage that validates and projects an outbound model request
 * into configured token limits without mutating the canonical session transcript.
 */
export const prepareBoundedModelRequest = (
    options: PrepareBoundedModelRequestOptions,
): ModelRequest => {
    const { request } = options;
    const effectiveProfile = options.profile ?? request.profile;
    const charsPerToken = effectiveProfile?.charsPerToken ?? 4;
    const maxToolOutputTokens = options.maxToolOutputTokens;

    let authoritativeBudget: number;
    let reservedOverhead: number;

    if (effectiveProfile) {
        const margin = effectiveProfile.safetyMarginTokens ?? 0;
        const profileInputCap =
            effectiveProfile.contextWindowTokens - effectiveProfile.maxOutputTokens - margin;

        if (options.budget !== undefined) {
            validateContextBudget(options.budget, maxToolOutputTokens);
            authoritativeBudget = Math.min(profileInputCap, options.budget.preferredInputTokens);
        } else {
            authoritativeBudget = profileInputCap;
        }
        reservedOverhead = 0;
    } else {
        const budget = options.budget !== undefined ? options.budget : DEFAULT_CONTEXT_BUDGET;
        validateContextBudget(budget, maxToolOutputTokens);
        authoritativeBudget = budget.preferredInputTokens;
        reservedOverhead = budget.reservedOverheadTokens;
    }

    const toolsOverhead = estimateToolsTokens(request.tools, charsPerToken);
    const effectiveBudget = authoritativeBudget - reservedOverhead - toolsOverhead;

    const formatOverflow = (reason: string, requiredTokens: number, capacity: number): string => {
        if (effectiveProfile) {
            const margin = effectiveProfile.safetyMarginTokens ?? 0;
            return (
                `${reason}: Required estimated tokens (${requiredTokens}) exceed available input capacity (${capacity} tokens). ` +
                `[Profile: contextWindow=${effectiveProfile.contextWindowTokens}, maxOutput=${effectiveProfile.maxOutputTokens}, safetyMargin=${margin}]`
            );
        }
        return `${reason}: Required estimated tokens (${requiredTokens}) exceed available budget (${capacity} tokens).`;
    };

    if (effectiveBudget < 0) {
        throw new ContextBudgetOverflowError(
            formatOverflow(
                "Reserved overhead and tool definitions exceed total budget",
                reservedOverhead + toolsOverhead,
                authoritativeBudget,
            ),
        );
    }

    const items = request.items;
    if (items.length === 0) {
        return {
            items: [],
            tools: request.tools,
            signal: request.signal,
            profile: effectiveProfile,
        };
    }

    // Identify trusted privileged system prefix at start of request
    const mandatorySystemItems: ModelItem[] = [];
    let firstNonPolicyIndex = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isPrivilegedPrefixItem(item)) {
            mandatorySystemItems.push(item);
            firstNonPolicyIndex = i + 1;
        } else {
            break;
        }
    }

    // Locate active turn: search backwards for real user prompt
    let activeTurnStartIndex = -1;
    for (let i = items.length - 1; i >= firstNonPolicyIndex; i--) {
        if (isRealUserPromptItem(items[i])) {
            activeTurnStartIndex = i;
            break;
        }
    }

    if (activeTurnStartIndex === -1) {
        activeTurnStartIndex = firstNonPolicyIndex;
    }

    const mandatorySystemTokens = mandatorySystemItems.reduce(
        (sum, it) => sum + estimateModelItemTokens(it, charsPerToken),
        0,
    );

    // Active turn items
    const activeTurnItems = items.slice(activeTurnStartIndex);

    const activePromptItem =
        activeTurnItems.length > 0 && isRealUserPromptItem(activeTurnItems[0])
            ? activeTurnItems[0]
            : null;

    const mandatoryPromptTokens = activePromptItem
        ? estimateModelItemTokens(activePromptItem, charsPerToken)
        : 0;
    const totalMandatoryTokens = mandatorySystemTokens + mandatoryPromptTokens;

    if (totalMandatoryTokens > effectiveBudget) {
        throw new ContextBudgetOverflowError(
            formatOverflow(
                "Mandatory request input exceeds available budget",
                totalMandatoryTokens,
                effectiveBudget,
            ),
        );
    }

    // Validate any configured maxToolOutputTokens bounds on active tool results
    if (maxToolOutputTokens !== undefined) {
        for (const item of activeTurnItems) {
            if (isToolResultItem(item)) {
                const itemTokens = estimateModelItemTokens(item, charsPerToken);
                if (itemTokens > maxToolOutputTokens) {
                    throw new ContextBudgetOverflowError(
                        formatOverflow(
                            `Tool result (${itemTokens} tokens) exceeds configured maxToolOutputTokens limit of ${maxToolOutputTokens}`,
                            itemTokens,
                            maxToolOutputTokens,
                        ),
                    );
                }
            }
        }
    }

    const actualActiveTurnTokens = activeTurnItems.reduce(
        (sum, it) => sum + estimateModelItemTokens(it, charsPerToken),
        0,
    );

    const baseRequiredTokens = mandatorySystemTokens + actualActiveTurnTokens;
    if (baseRequiredTokens > effectiveBudget) {
        throw new ContextBudgetOverflowError(
            formatOverflow(
                "Mandatory policy and current-turn activity exceed available budget",
                baseRequiredTokens,
                effectiveBudget,
            ),
        );
    }

    let remainingForHistory = Math.max(
        0,
        effectiveBudget - mandatorySystemTokens - actualActiveTurnTokens,
    );

    // Optional historical items
    const historicalSlice = items.slice(firstNonPolicyIndex, activeTurnStartIndex);
    const historicalGroups = groupHistoricalItems(historicalSlice, charsPerToken);
    const selectedHistory: ModelItem[] = [];

    // Walk backwards through complete historical groups, packing units that fit
    for (let i = historicalGroups.length - 1; i >= 0; i--) {
        const group = historicalGroups[i];
        if (group.estimatedTokens <= remainingForHistory) {
            selectedHistory.unshift(...group.items);
            remainingForHistory -= group.estimatedTokens;
        } else {
            break;
        }
    }

    const finalItems: ModelItem[] = [
        ...mandatorySystemItems,
        ...selectedHistory,
        ...activeTurnItems,
    ];

    const totalRequestTokens = estimateRequestTokens(
        finalItems,
        request.tools,
        reservedOverhead,
        charsPerToken,
    );

    if (totalRequestTokens > authoritativeBudget) {
        throw new ContextBudgetOverflowError(
            formatOverflow(
                "Final prepared model request exceeds context budget",
                totalRequestTokens,
                authoritativeBudget,
            ),
        );
    }

    return {
        items: finalItems,
        tools: request.tools,
        signal: request.signal,
        profile: effectiveProfile,
    };
};
