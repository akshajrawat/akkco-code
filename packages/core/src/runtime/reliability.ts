export type AgentLoopStopReason =
    | "max_tool_iterations"
    | "repeated_tool_call"
    | "repeated_tool_cycle"
    | "consecutive_tool_errors";

const getDefaultMessageForReason = (reason: AgentLoopStopReason): string => {
    switch (reason) {
        case "max_tool_iterations":
            return "Maximum tool iterations exceeded";
        case "repeated_tool_call":
            return "Agent loop terminated: repeated tool call detected without strategy change";
        case "repeated_tool_cycle":
            return "Agent loop terminated: repeated tool strategy cycle detected without strategy change";
        case "consecutive_tool_errors":
            return "Agent loop terminated: consecutive tool error limit reached";
    }
};

export class AgentLoopError extends Error {
    readonly reason: AgentLoopStopReason;

    constructor(
        reasonOrOptions: AgentLoopStopReason | { reason: AgentLoopStopReason; message?: string },
        message?: string,
    ) {
        const reason =
            typeof reasonOrOptions === "string" ? reasonOrOptions : reasonOrOptions.reason;
        const msg =
            (typeof reasonOrOptions === "object" ? reasonOrOptions.message : message) ??
            getDefaultMessageForReason(reason);
        super(msg);
        this.name = "AgentLoopError";
        this.reason = reason;
        Object.setPrototypeOf(this, AgentLoopError.prototype);
    }
}

export interface RuntimeReliabilityOptions {
    maxToolIterations?: number;
    repeatedToolCallLimit?: number;
    consecutiveToolErrorLimit?: number;
}

export const DEFAULT_RELIABILITY_OPTIONS: Required<RuntimeReliabilityOptions> = {
    maxToolIterations: 25,
    repeatedToolCallLimit: 3,
    consecutiveToolErrorLimit: 4,
};

export const canonicalizeValue = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(canonicalizeValue);
    }
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
        result[key] = canonicalizeValue(obj[key]);
    }
    return result;
};

export const getToolCallSignature = (name: string, args: unknown): string => {
    const canonicalArgs = args === undefined || args === null ? {} : canonicalizeValue(args);
    return JSON.stringify({
        name,
        arguments: canonicalArgs,
    });
};

export const validateReliabilityOptions = (
    options?: RuntimeReliabilityOptions,
): Required<RuntimeReliabilityOptions> => {
    if (
        options !== undefined &&
        (typeof options !== "object" || options === null || Array.isArray(options))
    ) {
        throw new Error("Invalid reliabilityOptions: must be an options object.");
    }

    const maxToolIterations =
        options?.maxToolIterations ?? DEFAULT_RELIABILITY_OPTIONS.maxToolIterations;
    const repeatedToolCallLimit =
        options?.repeatedToolCallLimit ?? DEFAULT_RELIABILITY_OPTIONS.repeatedToolCallLimit;
    const consecutiveToolErrorLimit =
        options?.consecutiveToolErrorLimit ?? DEFAULT_RELIABILITY_OPTIONS.consecutiveToolErrorLimit;

    if (
        typeof maxToolIterations !== "number" ||
        !Number.isFinite(maxToolIterations) ||
        !Number.isInteger(maxToolIterations) ||
        maxToolIterations <= 0
    ) {
        throw new Error(
            `Invalid maxToolIterations: ${maxToolIterations}. Must be a finite positive integer.`,
        );
    }

    if (
        typeof repeatedToolCallLimit !== "number" ||
        !Number.isFinite(repeatedToolCallLimit) ||
        !Number.isInteger(repeatedToolCallLimit) ||
        repeatedToolCallLimit <= 0
    ) {
        throw new Error(
            `Invalid repeatedToolCallLimit: ${repeatedToolCallLimit}. Must be a finite positive integer.`,
        );
    }

    if (
        typeof consecutiveToolErrorLimit !== "number" ||
        !Number.isFinite(consecutiveToolErrorLimit) ||
        !Number.isInteger(consecutiveToolErrorLimit) ||
        consecutiveToolErrorLimit <= 0
    ) {
        throw new Error(
            `Invalid consecutiveToolErrorLimit: ${consecutiveToolErrorLimit}. Must be a finite positive integer.`,
        );
    }

    return {
        maxToolIterations,
        repeatedToolCallLimit,
        consecutiveToolErrorLimit,
    };
};

export const resolveReliabilityOptions = validateReliabilityOptions;

export interface CycleDetectionResult {
    isCycle: boolean;
    cycleLength?: number;
    pattern?: string[];
}

export const detectRepeatedToolCycle = (
    history: readonly string[],
    newSignature: string,
    minCycleLength = 2,
    maxCycleLength = 8,
): CycleDetectionResult => {
    const candidate = [...history, newSignature];
    const maxL = Math.min(maxCycleLength, Math.floor(candidate.length / 2));

    for (let L = minCycleLength; L <= maxL; L++) {
        const lastSlice = candidate.slice(-L);
        const prevSlice = candidate.slice(-2 * L, -L);

        // Require at least two distinct elements in the cycle so that sequences
        // of purely identical calls (e.g. A A A) are handled by repeatedToolCallLimit
        if (new Set(lastSlice).size < 2) {
            continue;
        }

        let isMatch = true;
        for (let i = 0; i < L; i++) {
            if (lastSlice[i] !== prevSlice[i]) {
                isMatch = false;
                break;
            }
        }

        if (isMatch) {
            return {
                isCycle: true,
                cycleLength: L,
                pattern: lastSlice,
            };
        }
    }

    return { isCycle: false };
};
