import { createAkkcoRuntime, Session } from "@akkco/core";
import { toModelTools } from "@akkco/tools";
import {
    type CommandContext,
    type CommandMetadata,
    type CommandRegistry,
    createBuiltinCommandRegistry,
} from "../commands/command-registry.js";
import type {
    CliControllerOptions,
    CliPresentationEvent,
    CliViewState,
    HistoryItem,
} from "./types.js";

export const createCliController = ({
    provider,
    toolRegistry,
    commandRegistry = createBuiltinCommandRegistry(),
    reliabilityOptions,
}: CliControllerOptions) => {
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
            reliabilityOptions,
        ),
    );

    const exit = (farewell = true) => {
        if (state.exited) {
            return;
        }

        update({ queuedPrompts: [] });
        activeAbort?.abort();
        commitAssistant();

        if (farewell) {
            notice("Goodbye.");
        }

        update({ exited: true, assistantText: "", activeTool: undefined });
        emit({ type: "exit" });
    };

    const interrupt = () => {
        update({ queuedPrompts: [] });
        if (activeAbort) {
            activeAbort.abort();
            update({ outcome: "cancelled" });
        } else {
            exit();
        }
    };

    const commandContext: CommandContext = {
        session,
        toolRegistry,

        appendHistory: (item) => {
            append({ id: nextId++, ...item } as HistoryItem);
        },

        notice,
        exit,

        clearHistory: () => {
            update({
                history: [],
                historyVersion: state.historyVersion + 1,
                outcome: undefined,
            });
        },

        startTool,

        finishTool: (execution) => {
            if (execution.status === "failed") {
                update({ activeTool: undefined, outcome: "error" });
            } else {
                update({ activeTool: undefined });
            }

            append({
                id: nextId++,
                type: "tool",
                execution,
            });
        },
    };

    const submit = async (input: string) => {
        if (state.exited) {
            return;
        }

        if (!input.trim()) {
            if (state.status === "idle") {
                emit({ type: "idle" });
            }
            return;
        }

        if (state.status !== "idle") {
            update({ queuedPrompts: [...(state.queuedPrompts ?? []), input] });
            return;
        }

        const abort = new AbortController();
        activeAbort = abort;

        // Lock synchronously, including while an asynchronous command is executing.
        update({ status: "generating", outcome: undefined });

        try {
            if (await commandRegistry.dispatch(input.trim(), commandContext)) {
                return;
            }

            append({ id: nextId++, type: "message", role: "user", content: input });

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
                commitAssistant();
            }
        } catch (error) {
            notice(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
            activeAbort = undefined;
            const [nextPrompt, ...remaining] = state.queuedPrompts ?? [];
            update({ status: "idle", activeTool: undefined, queuedPrompts: remaining });

            if (!state.exited) {
                if (nextPrompt !== undefined) {
                    await submit(nextPrompt);
                } else {
                    emit({ type: "idle" });
                }
            }
        }
    };

    return {
        getSnapshot: () => state,
        getCommands: (): readonly CommandMetadata[] => commandRegistry.list(),

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
        notice,

        dispose: () => {
            exit(false);
            subscribers.clear();
            eventListeners.clear();
        },
    };
};

export type CliController = ReturnType<typeof createCliController>;
