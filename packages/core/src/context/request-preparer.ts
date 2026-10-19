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

/**
 * Truncates a native tool result payload to fit within a target token budget while reserving
 * space for framing overhead and appending an explicit truncation notice.
 */
export const truncateToolResult = (
    item: ModelToolResult,
    targetItemTokens: number,
    charsPerToken = 4,
): ModelToolResult => {
    const rawTokens = estimateModelItemTokens(item, charsPerToken);
    if (rawTokens <= targetItemTokens) {
        return item;
    }

    if (targetItemTokens < 8) {
        throw new ContextBudgetOverflowError(
            `Cannot truncate tool result: target budget of ${targetItemTokens} tokens is too small for message framing and truncation indicator.`,
        );
    }

    // Framing overhead for tool_result is 4 tokens (role/formatting)
    const maxContentTokens = targetItemTokens - 4;
    const maxChars = maxContentTokens * charsPerToken;

    const fullNotice = `\n\n[Output truncated: exceeded token budget limit of ${targetItemTokens} tokens. Original length: ${item.content.length} characters. Canonical transcript retains full tool output.]`;
    const shortNotice = `\n\n[Output truncated: ${item.content.length} chars.]`;
    const compactNotice = `\n\n[Output truncated]`;
    const minNotice = ` [Truncated]`;

    let notice = "";
    if (maxChars >= fullNotice.length) {
        notice = fullNotice;
    } else if (maxChars >= shortNotice.length) {
        notice = shortNotice;
    } else if (maxChars >= compactNotice.length) {
        notice = compactNotice;
    } else {
        notice = minNotice;
    }

    const retainedChars = Math.max(0, maxChars - notice.length);
    let finalContent = item.content.slice(0, retainedChars) + notice;

    while (
        estimateTokens(finalContent, charsPerToken) + 4 > targetItemTokens &&
        retainedChars > 0
    ) {
        finalContent = finalContent.slice(0, finalContent.length - notice.length - 1) + notice;
    }

    return {
        type: "tool_result",
        callId: item.callId,
        content: finalContent,
        isError: item.isError,
    };
};

/**
 * Truncates a compatibility tool result message, preserving XML boundary tags and
 * envelope metadata while bounding the inner payload to fit within the target token budget.
 */
export const truncateCompatibilityToolResult = (
    item: ModelMessage,
    targetItemTokens: number,
    charsPerToken = 4,
): ModelMessage => {
    const rawTokens = estimateModelItemTokens(item, charsPerToken);
    if (rawTokens <= targetItemTokens) {
        return item;
    }

    const meta = item.toolResultEnvelope!;
    const header = `<akkco_tool_result call_id="${meta.callId}" status="${meta.status}">\n`;
    const footer = `\n</akkco_tool_result>`;
    const envelopeFramingTokens = estimateTokens(header + footer, charsPerToken) + 4;

    if (targetItemTokens < envelopeFramingTokens + 8) {
        throw new ContextBudgetOverflowError(
            `Cannot truncate tool result envelope: target budget of ${targetItemTokens} tokens is too small for envelope tags and truncation indicator.`,
        );
    }

    const maxBodyTokens = targetItemTokens - envelopeFramingTokens;
    const maxChars = maxBodyTokens * charsPerToken;
    const originalBody = meta.rawBody ?? item.content;

    const fullNotice = `\n\n[Output truncated: exceeded token budget limit of ${targetItemTokens} tokens. Original length: ${originalBody.length} characters. Canonical transcript retains full tool output.]`;
    const shortNotice = `\n\n[Output truncated: ${originalBody.length} chars.]`;
    const compactNotice = `\n\n[Output truncated]`;
    const minNotice = ` [Truncated]`;

    let notice = "";
    if (maxChars >= fullNotice.length) {
        notice = fullNotice;
    } else if (maxChars >= shortNotice.length) {
        notice = shortNotice;
    } else if (maxChars >= compactNotice.length) {
        notice = compactNotice;
    } else {
        notice = minNotice;
    }

    const retainedChars = Math.max(0, maxChars - notice.length);
    let finalBody = originalBody.slice(0, retainedChars) + notice;

    while (
        estimateTokens(header + finalBody + footer, charsPerToken) + 4 > targetItemTokens &&
        retainedChars > 0
    ) {
        finalBody = finalBody.slice(0, finalBody.length - notice.length - 1) + notice;
    }

    return {
        ...item,
        content: `${header}${finalBody}${footer}`,
        toolResultEnvelope: {
            ...meta,
            rawBody: finalBody,
        },
    };
};

export const truncateAnyToolResult = (
    item: ModelItem,
    targetBudget: number,
    charsPerToken = 4,
): ModelItem => {
    if (item.type === "tool_result") {
        return truncateToolResult(item, targetBudget, charsPerToken);
    }
    if (item.type === "message" && item.toolResultEnvelope !== undefined) {
        return truncateCompatibilityToolResult(item, targetBudget, charsPerToken);
    }
    return item;
};

/**
 * Distributes available token capacity across tool results proportionally with a safety floor,
 * without complex multi-iteration fair-share algorithms.
 */
export const allocateToolResultBudgets = (
    desiredBudgets: readonly number[],
    totalAvailable: number,
    minPerItem = 8,
): number[] => {
    const n = desiredBudgets.length;
    if (n === 0) {
        return [];
    }

    const sumDesired = desiredBudgets.reduce((sum, b) => sum + b, 0);
    if (totalAvailable >= sumDesired) {
        return [...desiredBudgets];
    }

    const allocations = new Array<number>(n).fill(minPerItem);
    const availableAfterFloor = Math.max(0, totalAvailable - n * minPerItem);

    if (availableAfterFloor === 0) {
        return allocations;
    }

    const excessDesired = desiredBudgets.map((b) => Math.max(0, b - minPerItem));
    const totalExcessDesired = excessDesired.reduce((sum, b) => sum + b, 0);

    if (totalExcessDesired === 0) {
        return allocations;
    }

    let remainingToDistribute = availableAfterFloor;
    for (let i = 0; i < n; i++) {
        const share = Math.min(
            excessDesired[i],
            Math.floor((availableAfterFloor * excessDesired[i]) / totalExcessDesired),
        );
        allocations[i] += share;
        remainingToDistribute -= share;
    }

    for (let i = 0; i < n && remainingToDistribute > 0; i++) {
        const unmet = desiredBudgets[i] - allocations[i];
        if (unmet > 0) {
            const add = Math.min(unmet, remainingToDistribute);
            allocations[i] += add;
            remainingToDistribute -= add;
        }
    }

    return allocations;
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

    // Non-tool-result active turn items
    const activeNonToolResultTokens = activeTurnItems
        .filter((it) => !isToolResultItem(it))
        .reduce((sum, it) => sum + estimateModelItemTokens(it, charsPerToken), 0);

    const baseRequiredTokens = mandatorySystemTokens + activeNonToolResultTokens;
    if (baseRequiredTokens > effectiveBudget) {
        throw new ContextBudgetOverflowError(
            formatOverflow(
                "Mandatory policy and current-turn activity exceed available budget",
                baseRequiredTokens,
                effectiveBudget,
            ),
        );
    }

    const availableForToolResults = effectiveBudget - baseRequiredTokens;

    // Identify tool results in active turn
    const activeToolResultIndices: number[] = [];
    for (let i = 0; i < activeTurnItems.length; i++) {
        if (isToolResultItem(activeTurnItems[i])) {
            activeToolResultIndices.push(i);
        }
    }

    const boundedActiveTurnItems: ModelItem[] = [...activeTurnItems];

    if (activeToolResultIndices.length > 0) {
        const minTokensRequired = activeToolResultIndices.length * 8;
        if (availableForToolResults < minTokensRequired) {
            throw new ContextBudgetOverflowError(
                formatOverflow(
                    `Tool results in active turn cannot fit within available budget (${availableForToolResults} tokens available for ${activeToolResultIndices.length} results)`,
                    minTokensRequired,
                    availableForToolResults,
                ),
            );
        }

        const desiredBudgets = activeToolResultIndices.map((idx) => {
            const tr = activeTurnItems[idx];
            const est = estimateModelItemTokens(tr, charsPerToken);
            return maxToolOutputTokens !== undefined ? Math.min(est, maxToolOutputTokens) : est;
        });

        const allocatedBudgets = allocateToolResultBudgets(
            desiredBudgets,
            availableForToolResults,
            8,
        );

        for (let i = 0; i < activeToolResultIndices.length; i++) {
            const idx = activeToolResultIndices[i];
            const originalResult = activeTurnItems[idx];
            const targetBudget = allocatedBudgets[i];
            boundedActiveTurnItems[idx] = truncateAnyToolResult(
                originalResult,
                targetBudget,
                charsPerToken,
            );
        }
    }

    const actualActiveTurnTokens = boundedActiveTurnItems.reduce(
        (sum, it) => sum + estimateModelItemTokens(it, charsPerToken),
        0,
    );

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
        ...boundedActiveTurnItems,
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
