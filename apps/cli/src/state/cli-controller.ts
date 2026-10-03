import { createAkkcoRuntime, Session } from "@akkco/core";
import type { ModelProvider } from "@akkco/models";
import { toModelTools, type ToolRegistry } from "@akkco/tools";
import type { CliPresentationEvent, CliViewState, HistoryItem } from "./types.js";

export const createCliController = ({
    provider,
    toolRegistry,
}: {
    provider: ModelProvider;
    toolRegistry: ToolRegistry;
}) => {
    let state: CliViewState = {
        history: [],
        historyVersion: 0,
        assistantText: "",
        status: "idle",
        exited: false,
    };

    let nextId = 1;
    let activeAbort: AbortController | undefined;

    const subscribers = new Set<() => void>();
    const eventListeners = new Set<(event: CliPresentationEvent) => void>();

    const update = (changes: Partial<CliViewState>) => {
        state = { ...state, ...changes };

        for (const subscriber of subscribers) {
            subscriber();
        }
    };

    const emit = (event: CliPresentationEvent) => {
        for (const listener of eventListeners) {
            listener(event);
        }
    };

    const append = (item: HistoryItem) => {
        if (state.exited) {
            return;
        }

        update({ history: [...state.history, item] });
        emit({ type: "item", item });
    };

    const notice = (content: string, kind: "info" | "error" | "warning" = "info") => {
        if (kind === "error") {
            update({ outcome: "error" });
        }

        if (content === "Generation cancelled.") {
            update({ outcome: "cancelled" });
        }

        append({ id: nextId++, type: "notice", kind, content });
    };

    const commitAssistant = () => {
        if (!state.assistantText) {
            return;
        }

        const content = state.assistantText;
        update({ assistantText: "" });
        append({ id: nextId++, type: "message", role: "assistant", content });
    };

    const startTool = (toolName: string, input: unknown) => {
        commitAssistant();
        update({
            status: "tool",
            activeTool: { toolName, arguments: input, status: "running" },
        });
    };

    const maxToolIterationsEnv = process.env.AKKCO_MAX_TOOL_ITERATIONS
        ? Number(process.env.AKKCO_MAX_TOOL_ITERATIONS)
        : undefined;

    const maxToolIterations =
        typeof maxToolIterationsEnv === "number" && Number.isFinite(maxToolIterationsEnv)
            ? maxToolIterationsEnv
            : undefined;

    const session = new Session(
        createAkkcoRuntime(
            provider,
            {
                get tools() {
                    return toModelTools(toolRegistry.list());
                },
                execute: async (name, input) => {
                    startTool(name, input);
                    return toolRegistry.execute(name, input);
                },
            },
            maxToolIterations,
        ),
    );

    const exit = (farewell = true) => {
        if (state.exited) {
            return;
        }

        activeAbort?.abort();
        commitAssistant();

        if (farewell) {
            notice("Goodbye.");
        }

        update({ exited: true, assistantText: "", activeTool: undefined });
        emit({ type: "exit" });
    };

    const interrupt = () => {
        if (activeAbort) {
            activeAbort.abort();
            update({ outcome: "cancelled" });
        } else {
            exit();
        }
    };

    const executeCommand = async (input: string) => {
        if (input === "/exit") {
            exit();
            return true;
        }

        if (input === "/clear") {
            session.clear();
            update({ history: [], historyVersion: state.historyVersion + 1, outcome: undefined });
            notice("Conversation cleared.");
            return true;
        }

        if (input === "/tools") {
            append({
                id: nextId++,
                type: "tools",
                tools: toolRegistry.list().map(({ name, description }) => ({ name, description })),
            });
            return true;
        }

        if (input !== "/tool" && !input.startsWith("/tool ")) {
            return false;
        }

        const args = input.slice(5).trim();
        if (!args) {
            notice("Usage: /tool <name> [json]", "error");
            return true;
        }

        const firstSpace = args.indexOf(" ");
        const toolName = firstSpace === -1 ? args : args.slice(0, firstSpace);
        const rawJson = firstSpace === -1 ? "{}" : args.slice(firstSpace + 1).trim();

        let toolInput: unknown;
        try {
            toolInput = JSON.parse(rawJson || "{}");
        } catch {
            notice("Error: Invalid JSON input for tool.", "error");
            return true;
        }

        startTool(toolName, toolInput);
        const started = Date.now();

        try {
            const result = await toolRegistry.execute(toolName, toolInput);
            update({ activeTool: undefined });
            append({
                id: nextId++,
                type: "tool",
                execution: {
                    toolName,
                    arguments: toolInput,
                    status: "completed",
                    durationMs: Date.now() - started,
                    result: result.content,
                    showResult: true,
                },
            });
        } catch (error) {
            update({ activeTool: undefined, outcome: "error" });
            append({
                id: nextId++,
                type: "tool",
                execution: {
                    toolName,
                    arguments: toolInput,
                    status: "failed",
                    durationMs: Date.now() - started,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
        }

        return true;
    };

    const submit = async (input: string) => {
        if (state.exited || state.status !== "idle") {
            return;
        }

        if (!input.trim()) {
            emit({ type: "idle" });
            return;
        }

        // Lock synchronously, including while an asynchronous command is executing.
        update({ status: "generating", outcome: undefined });

        try {
            if (await executeCommand(input.trim())) {
                return;
            }

            append({ id: nextId++, type: "message", role: "user", content: input });

            const abort = new AbortController();
            activeAbort = abort;

            try {
                for await (const event of session.send(input, abort.signal)) {
                    if (state.exited) {
                        break;
                    }

                    if (event.type === "text") {
                        update({ assistantText: state.assistantText + event.content });
                        emit({ type: "text", content: event.content });
                    } else {
                        commitAssistant();
                        update({ activeTool: undefined, status: "generating" });
                        append({ id: nextId++, type: "tool", execution: event });
                    }
                }

                if (abort.signal.aborted) {
                    // Providers may end their stream normally after an abort.
                    commitAssistant();
                    notice("Generation cancelled.", "warning");
                }
            } catch (error) {
                commitAssistant();

                if (abort.signal.aborted) {
                    if (state.activeTool) {
                        append({
                            id: nextId++,
                            type: "tool",
                            execution: { ...state.activeTool, status: "cancelled" },
                        });
                    }

                    notice("Generation cancelled.", "warning");
                } else {
                    notice(
                        `Error: ${error instanceof Error ? error.message : String(error)}`,
                        "error",
                    );
                }
            } finally {
                activeAbort = undefined;
                commitAssistant();
            }
        } catch (error) {
            notice(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
            update({ status: "idle", activeTool: undefined });

            if (!state.exited) {
                emit({ type: "idle" });
            }
        }
    };

    return {
        getSnapshot: () => state,

        subscribe: (subscriber: () => void) => {
            subscribers.add(subscriber);

            return () => {
                subscribers.delete(subscriber);
            };
        },

        onEvent: (listener: (event: CliPresentationEvent) => void) => {
            eventListeners.add(listener);

            return () => {
                eventListeners.delete(listener);
            };
        },

        submit,
        interrupt,
        exit,

        dispose: () => {
            activeAbort?.abort();
            subscribers.clear();
            eventListeners.clear();
        },
    };
};

export type CliController = ReturnType<typeof createCliController>;
