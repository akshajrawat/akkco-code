import type { ModelItem, ModelRequest, ModelTool, ModelToolResult } from "@akkco/models";
import { type ContextBudget, DEFAULT_CONTEXT_BUDGET, validateContextBudget } from "./budget.js";
import { estimateModelItemTokens, estimateTokens } from "./token-estimator.js";

export class ContextBudgetOverflowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ContextBudgetOverflowError";
    }
}

export interface PrepareBoundedModelRequestOptions {
    readonly request: ModelRequest;
    readonly budget?: ContextBudget;
    readonly maxToolOutputTokens?: number;
}

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

export const estimateToolsTokens = (tools?: readonly ModelTool[]): number => {
    if (!tools || tools.length === 0) {
        return 0;
    }
    return tools.reduce((sum, t) => {
        const schemaStr = JSON.stringify(t.inputSchema ?? {});
        return (
            sum +
            estimateTokens(t.name) +
            estimateTokens(t.description) +
            estimateTokens(schemaStr) +
            8
        );
    }, 0);
};

export const estimateRequestTokens = (
    items: readonly ModelItem[],
    tools?: readonly ModelTool[],
    reservedOverheadTokens = 0,
): number => {
    const itemsTokens = items.reduce((sum, it) => sum + estimateModelItemTokens(it), 0);
    const toolsTokens = estimateToolsTokens(tools);
    return itemsTokens + toolsTokens + reservedOverheadTokens;
};

export const truncateToolResult = (
    item: ModelToolResult,
    targetItemTokens: number,
): ModelToolResult => {
    const rawTokens = estimateModelItemTokens(item);
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
    const maxChars = maxContentTokens * 4;

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

    while (estimateTokens(finalContent) + 4 > targetItemTokens && retainedChars > 0) {
        finalContent = finalContent.slice(0, finalContent.length - notice.length - 1) + notice;
    }

    return {
        type: "tool_result",
        callId: item.callId,
        content: finalContent,
        isError: item.isError,
    };
};

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
    let remaining = totalAvailable - n * minPerItem;
    if (remaining <= 0) {
        if (totalAvailable < n * minPerItem) {
            let left = totalAvailable;
            for (let i = 0; i < n; i++) {
                const share = Math.floor(totalAvailable / n);
                allocations[i] = Math.min(desiredBudgets[i], share);
                left -= allocations[i];
            }
            if (left > 0) {
                allocations[0] += left;
            }
        }
        return allocations;
    }

    const active = new Set<number>();
    for (let i = 0; i < n; i++) {
        if (desiredBudgets[i] > minPerItem) {
            active.add(i);
        }
    }

    while (active.size > 0 && remaining > 0) {
        const step = Math.max(1, Math.floor(remaining / active.size));
        for (const idx of Array.from(active)) {
            const need = desiredBudgets[idx] - allocations[idx];
            const add = Math.min(need, step, remaining);
            allocations[idx] += add;
            remaining -= add;
            if (allocations[idx] >= desiredBudgets[idx]) {
                active.delete(idx);
            }
            if (remaining <= 0) break;
        }
    }

    return allocations;
};

export interface HistoricalGroup {
    items: ModelItem[];
    estimatedTokens: number;
}

export const groupHistoricalItems = (
    items: readonly ModelItem[],
    maxToolOutputTokens?: number,
): HistoricalGroup[] => {
    const groups: HistoricalGroup[] = [];
    let currentGroup: ModelItem[] = [];

    const flushGroup = () => {
        if (currentGroup.length === 0) return;
        const tokens = currentGroup.reduce((sum, it) => sum + estimateModelItemTokens(it), 0);
        groups.push({ items: currentGroup, estimatedTokens: tokens });
        currentGroup = [];
    };

    for (let i = 0; i < items.length; i++) {
        let item = items[i];

        if (item.type === "tool_result" && maxToolOutputTokens !== undefined) {
            item = truncateToolResult(item, maxToolOutputTokens);
        }

        if (
            item.type === "message" &&
            (item.provenance?.source === "memory" || item.provenance?.source === "repository")
        ) {
            flushGroup();
            const tokens = estimateModelItemTokens(item);
            groups.push({ items: [item], estimatedTokens: tokens });
            continue;
        }

        if (item.type === "message" && item.role === "system") {
            flushGroup();
            const tokens = estimateModelItemTokens(item);
            groups.push({ items: [item], estimatedTokens: tokens });
            continue;
        }

        if (item.type === "message" && item.role === "user") {
            flushGroup();
            currentGroup.push(item);
            continue;
        }

        currentGroup.push(item);
    }

    flushGroup();
    return groups;
};

export const prepareBoundedModelRequest = (
    options: PrepareBoundedModelRequestOptions,
): ModelRequest => {
    const { request } = options;
    const budget = options.budget !== undefined ? options.budget : DEFAULT_CONTEXT_BUDGET;
    const maxToolOutputTokens = options.maxToolOutputTokens ?? 1500;

    // 1. Mandatory budget validation (must not be bypassed even on empty requests)
    validateContextBudget(budget, maxToolOutputTokens);

    // 2. Compute tools overhead and available capacity
    const toolsOverhead = estimateToolsTokens(request.tools);
    const effectiveBudget =
        budget.preferredInputTokens - budget.reservedOverheadTokens - toolsOverhead;

    if (effectiveBudget < 0) {
        throw new ContextBudgetOverflowError(
            `Reserved overhead and tool definitions (${budget.reservedOverheadTokens + toolsOverhead} tokens) exceed total budget (${budget.preferredInputTokens} tokens).`,
        );
    }

    const items = request.items;
    if (items.length === 0) {
        return {
            items: [],
            tools: request.tools,
            signal: request.signal,
        };
    }

    // 3. Identify trusted mandatory system policies at start of request
    const mandatorySystemItems: ModelItem[] = [];
    let firstNonPolicyIndex = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isMandatoryPolicyItem(item)) {
            mandatorySystemItems.push(item);
            firstNonPolicyIndex = i + 1;
        } else {
            break;
        }
    }

    // 4. Locate the active turn
    let activeTurnStartIndex = -1;
    const lastItem = items[items.length - 1];
    const isRepairTurn = Boolean(
        lastItem &&
        lastItem.type === "message" &&
        lastItem.role === "user" &&
        lastItem.content.includes("Akkco tool-call protocol"),
    );

    if (isRepairTurn) {
        // In a protocol repair turn, the last item is the repair instruction.
        // The active turn started at the user prompt before the assistant's failed attempt.
        for (let i = items.length - 2; i >= firstNonPolicyIndex; i--) {
            const it = items[i];
            if (
                it.type === "message" &&
                it.role === "user" &&
                it.provenance?.source !== "memory" &&
                it.provenance?.source !== "repository"
            ) {
                activeTurnStartIndex = i;
                break;
            }
        }
    } else {
        for (let i = items.length - 1; i >= firstNonPolicyIndex; i--) {
            const it = items[i];
            if (
                it.type === "message" &&
                it.role === "user" &&
                it.provenance?.source !== "memory" &&
                it.provenance?.source !== "repository"
            ) {
                activeTurnStartIndex = i;
                break;
            }
        }
    }

    if (activeTurnStartIndex === -1) {
        activeTurnStartIndex = firstNonPolicyIndex;
    }

    const mandatorySystemTokens = mandatorySystemItems.reduce(
        (sum, it) => sum + estimateModelItemTokens(it),
        0,
    );

    // 5. Active turn items
    const activeTurnItems = items.slice(activeTurnStartIndex);

    // If active turn starts with user message, it is mandatory user input
    const activePromptItem =
        activeTurnItems.length > 0 &&
        activeTurnItems[0].type === "message" &&
        activeTurnItems[0].role === "user"
            ? activeTurnItems[0]
            : null;

    const mandatoryPromptTokens = activePromptItem ? estimateModelItemTokens(activePromptItem) : 0;
    const totalMandatoryTokens = mandatorySystemTokens + mandatoryPromptTokens;

    if (totalMandatoryTokens > effectiveBudget) {
        throw new ContextBudgetOverflowError(
            `Mandatory request input (${totalMandatoryTokens} estimated tokens) exceeds available budget (${effectiveBudget} tokens).`,
        );
    }

    // Non-tool-result active turn items (user prompt, assistant prose, tool calls, repair instructions)
    const activeNonToolResultTokens = activeTurnItems
        .filter((it) => it.type !== "tool_result")
        .reduce((sum, it) => sum + estimateModelItemTokens(it), 0);

    const baseRequiredTokens = mandatorySystemTokens + activeNonToolResultTokens;
    if (baseRequiredTokens > effectiveBudget) {
        throw new ContextBudgetOverflowError(
            `Mandatory policy and current-turn activity (${baseRequiredTokens} estimated tokens) exceed available budget (${effectiveBudget} tokens).`,
        );
    }

    const availableForToolResults = effectiveBudget - baseRequiredTokens;

    // Identify tool results in active turn
    const activeToolResultIndices: number[] = [];
    for (let i = 0; i < activeTurnItems.length; i++) {
        if (activeTurnItems[i].type === "tool_result") {
            activeToolResultIndices.push(i);
        }
    }

    const boundedActiveTurnItems: ModelItem[] = [...activeTurnItems];

    if (activeToolResultIndices.length > 0) {
        const minTokensRequired = activeToolResultIndices.length * 8;
        if (availableForToolResults < minTokensRequired) {
            throw new ContextBudgetOverflowError(
                `Tool results in active turn cannot fit within available budget (${availableForToolResults} tokens available for ${activeToolResultIndices.length} results).`,
            );
        }

        const desiredBudgets = activeToolResultIndices.map((idx) => {
            const tr = activeTurnItems[idx] as ModelToolResult;
            return Math.min(estimateModelItemTokens(tr), maxToolOutputTokens);
        });

        const allocatedBudgets = allocateToolResultBudgets(
            desiredBudgets,
            availableForToolResults,
            8,
        );

        for (let i = 0; i < activeToolResultIndices.length; i++) {
            const idx = activeToolResultIndices[i];
            const originalResult = activeTurnItems[idx] as ModelToolResult;
            const targetBudget = allocatedBudgets[i];
            boundedActiveTurnItems[idx] = truncateToolResult(originalResult, targetBudget);
        }
    }

    const actualActiveTurnTokens = boundedActiveTurnItems.reduce(
        (sum, it) => sum + estimateModelItemTokens(it),
        0,
    );

    let remainingForHistory = Math.max(
        0,
        effectiveBudget - mandatorySystemTokens - actualActiveTurnTokens,
    );

    // 6. Optional historical items (between system policies and active turn)
    const historicalSlice = items.slice(firstNonPolicyIndex, activeTurnStartIndex);
    const historicalGroups = groupHistoricalItems(historicalSlice, maxToolOutputTokens);
    const selectedHistory: ModelItem[] = [];

    // Walk backwards through complete historical groups, packing units that fit
    for (let i = historicalGroups.length - 1; i >= 0; i--) {
        const group = historicalGroups[i];
        if (group.estimatedTokens <= remainingForHistory) {
            selectedHistory.unshift(...group.items);
            remainingForHistory -= group.estimatedTokens;
        } else {
            // Can no longer fit earlier atomic historical turns
            break;
        }
    }

    // 7. Assemble final prepared request items
    const finalItems: ModelItem[] = [
        ...mandatorySystemItems,
        ...selectedHistory,
        ...boundedActiveTurnItems,
    ];

    // 8. Final verification: calculate complete estimated request cost including overhead
    const totalRequestTokens = estimateRequestTokens(
        finalItems,
        request.tools,
        budget.reservedOverheadTokens,
    );

    if (totalRequestTokens > budget.preferredInputTokens) {
        throw new ContextBudgetOverflowError(
            `Final prepared model request (${totalRequestTokens} estimated tokens) exceeds preferred input budget (${budget.preferredInputTokens} tokens).`,
        );
    }

    return {
        items: finalItems,
        tools: request.tools,
        signal: request.signal,
    };
};
