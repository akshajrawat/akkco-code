import type {
    ContextBudget,
    ContextCompactor,
    ContextCompiler,
    RuntimeReliabilityOptions,
    RuntimeToolExecutionEvent,
    SessionPersistence,
} from "@akkco/core";
import type { ModelProfile, ModelProvider } from "@akkco/models";
import type { ConversationStore } from "@akkco/retrieval";
import type { CommandRegistry } from "../commands/command-registry.js";
import type { ToolRegistry } from "@akkco/tools";

export interface CliControllerOptions {
    provider: ModelProvider;
    toolRegistry: ToolRegistry;
    commandRegistry?: CommandRegistry;
    reliabilityOptions?: RuntimeReliabilityOptions;
    compiler?: ContextCompiler;
    createCompiler?: (sessionId: string) => ContextCompiler;
    persistence?: SessionPersistence;
    sessionId?: string;
    profile?: ModelProfile;
    compactor?: ContextCompactor;
    budget?: ContextBudget;
    store?: ConversationStore;
    metadata?: CliMetadata;
    milestones?: boolean;
}

export type NoticeKind = "info" | "error" | "warning";

export type CliStatus = "idle" | "generating" | "tool";

export type CliOutcome = "cancelled" | "error";

export type CliMetadata = {
    version: string;
    provider: string;
    model: string;
    toolMode: "native" | "compatibility";
    cwd: string;
};

export type CompactionState = {
    active: boolean;
    scope: "history" | "tool";
    toolName?: string;
};

export type ToolExecutionState = Omit<RuntimeToolExecutionEvent, "type" | "callId" | "status"> & {
    status: RuntimeToolExecutionEvent["status"] | "running" | "requested";
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
          kind: NoticeKind;
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
    compaction?: CompactionState;
    status: CliStatus;
    outcome?: CliOutcome;
    queuedPrompts?: readonly string[];
    exited: boolean;
};

export type CliPresentationEvent =
    | { type: "text"; content: string }
    | { type: "item"; item: HistoryItem }
    | { type: "idle" }
    | { type: "exit" };
