import { Box, Static, render, useApp, useStdout } from "ink";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import process from "node:process";
import { Conversation } from "./components/Conversation.js";
import { Header } from "./components/Header.js";
import { PromptInput } from "./components/PromptInput.js";
import { StatusBar } from "./components/StatusBar.js";
import type { CliController } from "./state/cli-controller.js";
import type { CliMetadata } from "./state/types.js";
import { useCliController } from "./state/use-cli-controller.js";
import { buildConversationLines, calculateLayout, visibleConversation } from "./ui/layout.js";
import { calculateSuggestionsHeight } from "./ui/command-suggestions.js";
import { copyToClipboard, enterTerminal } from "./ui/terminal.js";

export const App = ({
    controller,
    metadata,
}: {
    controller: CliController;
    metadata: CliMetadata;
}) => {
    const state = useCliController(controller);
    const { stdout } = useStdout();
    const { exit } = useApp();

    const [size, setSize] = useState(() => ({
        columns: stdout.columns || 80,
        rows: stdout.rows || 24,
    }));

    const layout = calculateLayout(size.columns, size.rows);

    const activeLines = useMemo(
        () => buildConversationLines({ ...state, history: [] }, Math.max(1, layout.width - 2)),
        [state.assistantText, state.activeTool, layout.width],
    );
    const startupVersion = useRef(state.historyVersion);
    const staticItems = useMemo(
        () => [
            ...(state.historyVersion === startupVersion.current
                ? [{ type: "header" as const, id: "header" }]
                : []),
            ...state.history,
        ],
        [state.history, state.historyVersion],
    );
    const committed = useRef({
        version: state.historyVersion,
        count: 0,
        headerPrinted: false,
        visibleRows: 0,
    });
    const [scrollOffset, setScrollOffset] = useState(0);
    const previous = useRef({ count: activeLines.length, version: state.historyVersion });
    const previousRows = useRef(size.rows);

    useEffect(() => {
        const onResize = () => {
            const rows = stdout.rows || 24;
            // On shrink, Ink erases its previous live frame from the new cursor row.
            // Account for the committed rows consumed by that erase before filling free space.
            committed.current.visibleRows = Math.max(
                0,
                committed.current.visibleRows - Math.max(0, previousRows.current - rows),
            );
            previousRows.current = rows;
            setSize({ columns: stdout.columns || 80, rows });
        };

        // Resize the live frame before Ink's own resize listener can render stale dimensions.
        stdout.prependListener("resize", onResize);

        return () => {
            stdout.off("resize", onResize);
        };
    }, [stdout]);

    useLayoutEffect(() => {
        const delta = activeLines.length - previous.current.count;
        const cleared =
            previous.current.version !== state.historyVersion || activeLines.length === 0;

        setScrollOffset((offset) => {
            return cleared ? 0 : offset ? Math.max(0, offset + delta) : 0;
        });

        previous.current = { count: activeLines.length, version: state.historyVersion };
    }, [activeLines.length, state.historyVersion]);

    useEffect(() => {
        if (state.exited) {
            exit();
        }
    }, [state.exited, exit]);

    const [suggestionCount, setSuggestionCount] = useState(0);
    const maxSuggestionsVisible = Math.min(5, Math.max(0, layout.height - layout.footerHeight - 2));
    const suggestionsHeight =
        maxSuggestionsVisible > 0
            ? calculateSuggestionsHeight(suggestionCount, maxSuggestionsVisible)
            : 0;

    // Keep the redrawable area below terminal height: Ink otherwise clears scrollback.
    const activeHeight = Math.max(0, layout.height - layout.footerHeight - suggestionsHeight);
    const viewport = visibleConversation(activeLines, activeHeight, scrollOffset);
    const newHistory = state.history.slice(
        committed.current.version === state.historyVersion ? committed.current.count : 0,
    );
    const newRows = buildConversationLines(
        { ...state, history: newHistory, assistantText: "", activeTool: undefined },
        Math.max(1, layout.width - 2),
    ).length;
    const committedRows =
        committed.current.visibleRows +
        newRows +
        (committed.current.headerPrinted ? 0 : layout.headerHeight);
    const dynamicRows = viewport.lines.length + layout.footerHeight + suggestionsHeight;
    // Keep the composer docked while static history progressively consumes the free space.
    // Track visible committed rows, rather than total history, so growing the terminal also docks it.
    const spacerHeight = Math.max(0, layout.height - committedRows - dynamicRows);

    useLayoutEffect(() => {
        committed.current = {
            version: state.historyVersion,
            count: state.history.length,
            headerPrinted: true,
            visibleRows: Math.min(committedRows, Math.max(0, layout.height - dynamicRows)),
        };
    });

    const scroll = (direction: "up" | "down", linesToScroll?: number) => {
        setScrollOffset((offset) => {
            const maxOffset = Math.max(0, activeLines.length - activeHeight);

            if (linesToScroll === Infinity) {
                return direction === "up" ? maxOffset : 0;
            }

            const delta = linesToScroll ?? Math.max(1, activeHeight - 1);
            return Math.max(0, Math.min(maxOffset, offset + (direction === "up" ? delta : -delta)));
        });
    };

    const handleCopy = (draftText?: string) => {
        if (draftText && draftText.trim()) {
            copyToClipboard(draftText, stdout);
            controller.notice("Copied draft to clipboard.");
            return;
        }

        const lastAssistant = [...state.history]
            .reverse()
            .find((item) => item.type === "message" && item.role === "assistant");

        if (lastAssistant && lastAssistant.type === "message" && lastAssistant.content) {
            copyToClipboard(lastAssistant.content, stdout);
            controller.notice("Copied last response to clipboard.");
        } else {
            controller.notice("No response to copy.");
        }
    };

    return (
        <Box flexDirection="column" width={layout.width}>
            <Static key={state.historyVersion} items={staticItems}>
                {(item) =>
                    item.type === "header" ? (
                        <Header key={item.id} metadata={metadata} layout={layout} />
                    ) : (
                        <Conversation
                            key={item.id}
                            lines={buildConversationLines(
                                {
                                    ...state,
                                    history: [item],
                                    assistantText: "",
                                    activeTool: undefined,
                                },
                                Math.max(1, layout.width - 2),
                            )}
                        />
                    )
                }
            </Static>

            {viewport.lines.length > 0 && <Conversation lines={viewport.lines} />}
            {spacerHeight > 0 && <Box height={spacerHeight} flexShrink={0} />}

            <Box paddingX={layout.width >= 4 ? 1 : 0} flexDirection="column" flexShrink={0}>
                <PromptInput
                    disabled={state.exited}
                    columns={Math.max(1, layout.width >= 4 ? layout.width - 2 : layout.width)}
                    rows={layout.promptRows}
                    compact={layout.height < 3 || layout.width < 10}
                    maxSuggestionsVisible={maxSuggestionsVisible}
                    commands={controller.getCommands?.() ?? []}
                    onSuggestionsCountChange={setSuggestionCount}
                    onSubmit={async (value) => {
                        setScrollOffset(0);
                        await controller.submit(value);
                    }}
                    onInterrupt={controller.interrupt}
                    onScroll={scroll}
                    onCopy={handleCopy}
                />

                {layout.height >= 6 && (
                    <StatusBar
                        metadata={metadata}
                        state={state}
                        columns={Math.max(1, layout.width - 2)}
                        offset={viewport.offset}
                    />
                )}
            </Box>
        </Box>
    );
};

export const runInteractiveCli = async (controller: CliController, metadata: CliMetadata) => {
    const restore = enterTerminal();

    let instance: ReturnType<typeof render> | undefined;
    let shuttingDown = false;

    const terminate = () => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        process.exitCode = 143;
        controller.exit(false);
        instance?.unmount();
    };

    const hangup = () => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        process.exitCode = 129;
        controller.exit(false);
        instance?.unmount();
    };

    process.on("SIGTERM", terminate);
    process.on("SIGHUP", hangup);

    try {
        instance = render(null, {
            exitOnCtrlC: false,
            patchConsole: false,
        });

        // Register exit handling before App can fail during its initial render.
        const exited = instance.waitUntilExit();
        instance.rerender(<App controller={controller} metadata={metadata} />);
        await exited;
    } finally {
        instance?.unmount();
        restore();
        process.off("SIGTERM", terminate);
        process.off("SIGHUP", hangup);
    }
};
