import { Box, Text, render, useApp, useStdout } from "ink";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import process from "node:process";
import { Conversation } from "./components/Conversation.js";
import { Header } from "./components/Header.js";
import { PromptInput } from "./components/PromptInput.js";
import { StatusBar } from "./components/StatusBar.js";
import type { CliController } from "./state/cli-controller.js";
import type { CliMetadata } from "./state/types.js";
import { useCliController } from "./state/use-cli-controller.js";
import { palette } from "./theme/palette.js";
import { buildConversationLines, calculateLayout, visibleConversation } from "./ui/layout.js";
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

    const historyLines = useMemo(
        () =>
            buildConversationLines(
                { ...state, assistantText: "", activeTool: undefined },
                Math.max(1, layout.width - 2),
            ),
        [state.history, layout.width],
    );

    const activeLines = useMemo(
        () => buildConversationLines({ ...state, history: [] }, Math.max(1, layout.width - 2)),
        [state.assistantText, state.activeTool, layout.width],
    );

    const lines = useMemo(() => [...historyLines, ...activeLines], [historyLines, activeLines]);

    const [scrollOffset, setScrollOffset] = useState(0);
    const previous = useRef({ count: lines.length, version: state.historyVersion });

    useEffect(() => {
        const onResize = () => {
            setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
        };

        stdout.on("resize", onResize);

        return () => {
            stdout.off("resize", onResize);
        };
    }, [stdout]);

    useLayoutEffect(() => {
        const delta = lines.length - previous.current.count;
        const cleared = previous.current.version !== state.historyVersion;

        setScrollOffset((offset) => {
            return cleared ? 0 : offset ? Math.max(0, offset + delta) : 0;
        });

        previous.current = { count: lines.length, version: state.historyVersion };
    }, [lines.length, state.historyVersion]);

    useEffect(() => {
        if (state.exited) {
            exit();
        }
    }, [state.exited, exit]);

    const [suggestionsHeight, setSuggestionsHeight] = useState(0);

    const effectiveConversationHeight = Math.max(0, layout.conversationHeight - suggestionsHeight);
    const effectiveFooterHeight = layout.footerHeight + suggestionsHeight;

    const viewport = visibleConversation(lines, effectiveConversationHeight, scrollOffset);

    const scroll = (direction: "up" | "down", linesToScroll?: number) => {
        setScrollOffset((offset) => {
            const maxOffset = Math.max(0, lines.length - effectiveConversationHeight);

            if (linesToScroll === Infinity) {
                return direction === "up" ? maxOffset : 0;
            }

            const delta = linesToScroll ?? Math.max(1, effectiveConversationHeight - 1);
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
        <Box flexDirection="column" width={layout.width} height={layout.height} overflow="hidden">
            <Header metadata={metadata} layout={layout} />

            <Conversation
                lines={viewport.lines}
                height={effectiveConversationHeight}
                empty={lines.length === 0}
            />

            <Box flexDirection="column" height={effectiveFooterHeight} flexShrink={0}>
                {layout.footerHeight >= 3 && (
                    <Text color={palette.muted}>{"─".repeat(layout.width)}</Text>
                )}

                <Box paddingX={layout.width >= 4 ? 1 : 0} flexDirection="column">
                    <PromptInput
                        disabled={state.status !== "idle" || state.exited}
                        columns={layout.width}
                        rows={layout.promptRows}
                        commands={controller.getCommands?.() ?? []}
                        onSuggestionsHeightChange={setSuggestionsHeight}
                        onSubmit={async (value) => {
                            setScrollOffset(0);
                            await controller.submit(value);
                        }}
                        onInterrupt={controller.interrupt}
                        onScroll={scroll}
                        onCopy={handleCopy}
                    />

                    {layout.footerHeight >= 2 && (
                        <StatusBar
                            metadata={metadata}
                            state={state}
                            columns={Math.max(1, layout.width - 2)}
                            offset={viewport.offset}
                        />
                    )}
                </Box>
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
