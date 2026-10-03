import type { RuntimeToolExecutionEvent } from "@akkco/core";

export type CliMetadata = {
    version: string;
    provider: string;
    model: string;
    toolMode: "native" | "compatibility";
    cwd: string;
};

export type ToolExecutionState = Omit<RuntimeToolExecutionEvent, "type" | "callId" | "status"> & {
    status: RuntimeToolExecutionEvent["status"] | "running";
    showResult?: boolean;
};

export type HistoryItemPayload =
    | {
          type: "message";
          role: "user" | "assistant";
          content: string;
      }
    | {
          type: "tool";
          execution: ToolExecutionState;
      }
    | {
          type: "notice";
          kind: "info" | "error" | "warning";
          content: string;
      }
    | {
          type: "tools";
          tools: { name: string; description: string }[];
      };

export type HistoryItem = HistoryItemPayload & { id: number };

export type CliViewState = {
    history: HistoryItem[];
    historyVersion: number;
    assistantText: string;
    activeTool?: ToolExecutionState;
    status: "idle" | "generating" | "tool";
    outcome?: "cancelled" | "error";
    exited: boolean;
};

export type CliPresentationEvent =
    | { type: "text"; content: string }
    | { type: "item"; item: HistoryItem }
    | { type: "idle" }
    | { type: "exit" };
