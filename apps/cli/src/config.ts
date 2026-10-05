export type ToolMode = "native" | "compatibility";

export const parseToolMode = (envValue?: string): ToolMode => {
    if (envValue === undefined) {
        return "compatibility";
    }
    if (envValue === "native" || envValue === "compatibility") {
        return envValue;
    }
    throw new Error(
        `Invalid AKKCO_TOOL_MODE: "${envValue}". Supported values are "native" and "compatibility".`,
    );
};

export const parseMaxToolIterations = (envValue?: string): number | undefined => {
    if (envValue === undefined) {
        return undefined;
    }
    const trimmed = envValue.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
            `Invalid AKKCO_MAX_TOOL_ITERATIONS: "${envValue}". Must be a finite positive integer.`,
        );
    }
    return parsed;
};
