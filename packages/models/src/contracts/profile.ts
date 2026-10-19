export interface ModelProfile {
    id: string;
    backend?: string;
    contextWindowTokens: number;
    maxOutputTokens: number;
    safetyMarginTokens?: number;
    toolMode: "native" | "compatibility";
    charsPerToken?: number;
}
