import type { ModelTool } from "@akkco/models";

export type RuntimeToolHost = {
    tools: ModelTool[];
    execute: (name: string, input: unknown) => Promise<{ content: string }>;
};
