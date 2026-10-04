import { Box, Text, useStdin } from "ink";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommandMetadata } from "../commands/command-registry.js";
import { palette } from "../theme/palette.js";
import {
    applyCompletion,
    commandExpectsArguments,
    filterCommands,
    getCommandPrefix,
    getNextSelection,
} from "../ui/command-suggestions.js";
import { promptViewport } from "../ui/layout.js";
import { createTerminalInput } from "../ui/terminal-input.js";
import { CommandSuggestions } from "./CommandSuggestions.js";

export const PromptInput = ({
    disabled,
    columns,
    rows,
    commands = [],
    compact = false,
    maxSuggestionsVisible = 5,
    onSubmit,
    onInterrupt,
    onScroll,
    onCopy,
    onSuggestionsCountChange,
}: {
    disabled: boolean;
    columns: number;
    rows: number;
    commands?: readonly CommandMetadata[];
    compact?: boolean;
    maxSuggestionsVisible?: number;
    onSubmit: (input: string) => Promise<void>;
    onInterrupt: () => void;
    onScroll?: (direction: "up" | "down", lines?: number) => void;
    onCopy?: (draftText?: string) => void;
    onSuggestionsCountChange?: (count: number) => void;
}) => {
    const { stdin, setRawMode } = useStdin();
    const draft = useRef({ characters: [] as string[], cursor: 0 });
    const autocomplete = useRef({ selectedIndex: 0, dismissed: false });
    const currentCommands = useRef(commands);
    currentCommands.current = commands;

    const actions = useRef({
        disabled,
        onSubmit,
        onInterrupt,
        onScroll,
        onCopy,
        maxSuggestionsVisible,
        onSuggestionsCountChange,
    });
    actions.current = {
        disabled,
        onSubmit,
        onInterrupt,
        onScroll,
        onCopy,
        maxSuggestionsVisible,
        onSuggestionsCountChange,
    };

    const [, setRevision] = useState(0);
    const redraw = () => {
        const { characters, cursor } = draft.current;
        const prefix = getCommandPrefix(characters.join(""), cursor);
        const callbacks = actions.current;
        const count =
            !callbacks.disabled && !autocomplete.current.dismissed && prefix !== null
                ? filterCommands(currentCommands.current, prefix).length
                : 0;
        // Notify before rendering: the parent must reserve the popup's rows in the same frame.
        callbacks.onSuggestionsCountChange?.(count);
        setRevision((value) => value + 1);
    };

    // Compute suggestion state for rendering and layout notification
    const currentText = draft.current.characters.join("");
    const currentCursor = draft.current.cursor;
    const prefix = getCommandPrefix(currentText, currentCursor);
    const matchingCommands = prefix !== null ? filterCommands(commands, prefix) : [];
    const showSuggestions =
        !disabled &&
        maxSuggestionsVisible > 0 &&
        !autocomplete.current.dismissed &&
        matchingCommands.length > 0;

    if (
        matchingCommands.length > 0 &&
        autocomplete.current.selectedIndex >= matchingCommands.length
    ) {
        autocomplete.current.selectedIndex = 0;
    }

    const suggestionCount =
        !disabled && !autocomplete.current.dismissed ? matchingCommands.length : 0;

    useLayoutEffect(() => {
        onSuggestionsCountChange?.(suggestionCount);
    }, [suggestionCount, onSuggestionsCountChange]);

    useEffect(() => {
        return () => {
            onSuggestionsCountChange?.(0);
        };
    }, [onSuggestionsCountChange]);

    useLayoutEffect(() => {
        const parse = createTerminalInput((event) => {
            const current = draft.current;
            const callbacks = actions.current;

            if (event.type === "key" && event.key === "interrupt") {
                callbacks.onInterrupt();
                return;
            }

            if (event.type === "scroll") {
                callbacks.onScroll?.(event.direction, event.lines);
                return;
            }

            if (event.type === "key" && (event.key === "pageUp" || event.key === "pageDown")) {
                callbacks.onScroll?.(event.key === "pageUp" ? "up" : "down");
                return;
            }

            if (callbacks.disabled) {
                if (event.type === "key" && (event.key === "up" || event.key === "down")) {
                    callbacks.onScroll?.(event.key === "up" ? "up" : "down", 1);
                }
                return;
            }

            // Check if suggestions are currently active
            const activeText = current.characters.join("");
            const activeCursor = current.cursor;
            const activePrefix = getCommandPrefix(activeText, activeCursor);
            const activeMatches =
                activePrefix !== null ? filterCommands(currentCommands.current, activePrefix) : [];
            const isSuggestionsOpen =
                callbacks.maxSuggestionsVisible > 0 &&
                !autocomplete.current.dismissed &&
                activeMatches.length > 0;

            if (isSuggestionsOpen) {
                if (event.type === "key" && event.key === "up") {
                    autocomplete.current.selectedIndex = getNextSelection(
                        autocomplete.current.selectedIndex,
                        activeMatches.length,
                        "up",
                    );
                    redraw();
                    return;
                }

                if (event.type === "key" && event.key === "down") {
                    autocomplete.current.selectedIndex = getNextSelection(
                        autocomplete.current.selectedIndex,
                        activeMatches.length,
                        "down",
                    );
                    redraw();
                    return;
                }

                if (event.type === "key" && event.key === "tab") {
                    const selected = activeMatches[autocomplete.current.selectedIndex];
                    if (selected) {
                        const completed = applyCompletion(activeText, activeCursor, selected);
                        current.characters = Array.from(completed.text);
                        current.cursor = completed.cursor;
                        autocomplete.current.selectedIndex = 0;
                        redraw();
                    }
                    return;
                }

                if (event.type === "key" && event.key === "enter") {
                    const selected = activeMatches[autocomplete.current.selectedIndex];
                    if (selected) {
                        if (commandExpectsArguments(selected)) {
                            const completed = applyCompletion(activeText, activeCursor, selected);
                            current.characters = Array.from(completed.text);
                            current.cursor = completed.cursor;
                            autocomplete.current.selectedIndex = 0;
                            redraw();
                            return;
                        }

                        const value = `/${selected.name}`;
                        draft.current = { characters: [], cursor: 0 };
                        autocomplete.current.dismissed = false;
                        autocomplete.current.selectedIndex = 0;
                        void callbacks.onSubmit(value);
                        redraw();
                        return;
                    }
                }

                if (event.type === "key" && event.key === "escape") {
                    autocomplete.current.dismissed = true;
                    redraw();
                    return;
                }
            } else if (event.type === "key" && (event.key === "tab" || event.key === "escape")) {
                return;
            }

            if (event.type === "key" && event.key === "copy") {
                callbacks.onCopy?.(current.characters.join(""));
                return;
            }

            // Reset dismissal and selection when prompt is edited
            if (
                event.type !== "key" ||
                event.key === "backspace" ||
                event.key === "delete" ||
                event.key === "clear"
            ) {
                autocomplete.current.dismissed = false;
                autocomplete.current.selectedIndex = 0;
            }

            if (event.type !== "key") {
                const inserted = Array.from(event.text);
                current.characters.splice(current.cursor, 0, ...inserted);
                current.cursor += inserted.length;
            } else if (event.key === "enter") {
                const value = current.characters.join("");
                draft.current = { characters: [], cursor: 0 };
                autocomplete.current.dismissed = false;
                autocomplete.current.selectedIndex = 0;
                void callbacks.onSubmit(value);
            } else if (event.key === "left") {
                current.cursor = Math.max(0, current.cursor - 1);
            } else if (event.key === "right") {
                current.cursor = Math.min(current.characters.length, current.cursor + 1);
            } else if (event.key === "backspace" && current.cursor > 0) {
                current.characters.splice(--current.cursor, 1);
            } else if (event.key === "delete") {
                current.characters.splice(current.cursor, 1);
            } else if (event.key === "clear") {
                draft.current = { characters: [], cursor: 0 };
            } else {
                const start = current.characters.slice(0, current.cursor).lastIndexOf("\n") + 1;
                const nextBreak = current.characters.indexOf("\n", current.cursor);
                const end = nextBreak === -1 ? current.characters.length : nextBreak;

                if (event.key === "home") {
                    if (current.characters.length === 0) {
                        callbacks.onScroll?.("up", Infinity);
                        return;
                    }

                    current.cursor = start;
                } else if (event.key === "end") {
                    if (current.characters.length === 0) {
                        callbacks.onScroll?.("down", Infinity);
                        return;
                    }

                    current.cursor = end;
                } else if (event.key === "up") {
                    if (current.characters.length === 0) {
                        callbacks.onScroll?.("up", 1);
                        return;
                    }

                    if (start > 0) {
                        const previousStart =
                            current.characters.slice(0, start - 1).lastIndexOf("\n") + 1;
                        current.cursor = Math.min(
                            start - 1,
                            previousStart + current.cursor - start,
                        );
                    } else {
                        callbacks.onScroll?.("up", 1);
                        return;
                    }
                } else if (event.key === "down") {
                    if (current.characters.length === 0) {
                        callbacks.onScroll?.("down", 1);
                        return;
                    }

                    if (end < current.characters.length) {
                        const nextEnd = current.characters.indexOf("\n", end + 1);
                        current.cursor = Math.min(
                            nextEnd === -1 ? current.characters.length : nextEnd,
                            end + 1 + current.cursor - start,
                        );
                    } else {
                        callbacks.onScroll?.("down", 1);
                        return;
                    }
                }
            }

            redraw();
        });

        const onData = (chunk: string | Buffer) => parse(chunk.toString());

        stdin.on("data", onData);
        setRawMode(true);

        return () => {
            stdin.off("data", onData);
            setRawMode(false);
        };
    }, [stdin, setRawMode]);

    const lines = promptViewport(
        draft.current.characters,
        draft.current.cursor,
        Math.max(1, columns - (compact ? 2 : 6)),
        rows,
    );

    const suggestionsWidth = Math.max(1, columns);

    return (
        <Box flexDirection="column">
            {showSuggestions && (
                <CommandSuggestions
                    commands={matchingCommands}
                    selectedIndex={autocomplete.current.selectedIndex}
                    width={suggestionsWidth}
                    maxVisible={maxSuggestionsVisible}
                />
            )}

            <Box
                flexDirection="column"
                borderStyle={compact ? undefined : "round"}
                borderColor={disabled ? palette.muted : palette.primary}
                paddingX={compact ? 0 : 1}
                height={rows + (compact ? 0 : 2)}
                flexShrink={0}
            >
                {lines.map((line, index) => (
                    <Text key={index} wrap="truncate-end">
                        <Text color={palette.primary} bold>
                            {index === 0 ? "› " : "  "}
                        </Text>
                        {line.cursor === undefined || disabled ? (
                            line.characters.join("")
                        ) : (
                            <>
                                {line.characters.slice(0, line.cursor).join("")}
                                <Text inverse>{line.characters[line.cursor] ?? " "}</Text>
                                {line.characters.slice(line.cursor + 1).join("")}
                                {draft.current.characters.length === 0 && (
                                    <Text dimColor>Ask Akkco anything…</Text>
                                )}
                            </>
                        )}
                    </Text>
                ))}
            </Box>
        </Box>
    );
};
