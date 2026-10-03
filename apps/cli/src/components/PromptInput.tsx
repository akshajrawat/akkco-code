import { Box, Text, useStdin } from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import { palette } from "../theme/palette.js";
import { promptViewport } from "../ui/layout.js";
import { createTerminalInput } from "../ui/terminal-input.js";

export const PromptInput = ({
    disabled,
    columns,
    rows,
    onSubmit,
    onInterrupt,
    onScroll,
}: {
    disabled: boolean;
    columns: number;
    rows: number;
    onSubmit: (input: string) => Promise<void>;
    onInterrupt: () => void;
    onScroll: (direction: "up" | "down", lines?: number) => void;
}) => {
    const { stdin, setRawMode } = useStdin();
    const draft = useRef({ characters: [] as string[], cursor: 0 });
    const actions = useRef({ disabled, onSubmit, onInterrupt, onScroll });

    actions.current = { disabled, onSubmit, onInterrupt, onScroll };
    const [, redraw] = useState(0);

    useLayoutEffect(() => {
        const parse = createTerminalInput((event) => {
            const current = draft.current;
            const callbacks = actions.current;

            if (event.type === "key" && event.key === "interrupt") {
                callbacks.onInterrupt();
                return;
            }

            if (event.type === "scroll") {
                callbacks.onScroll(event.direction, event.lines);
                return;
            }

            if (event.type === "key" && (event.key === "pageUp" || event.key === "pageDown")) {
                callbacks.onScroll(event.key === "pageUp" ? "up" : "down");
                return;
            }

            if (callbacks.disabled) {
                if (event.type === "key" && (event.key === "up" || event.key === "down")) {
                    callbacks.onScroll(event.key === "up" ? "up" : "down", 1);
                }
                return;
            }

            if (event.type !== "key") {
                const inserted = Array.from(event.text);
                current.characters.splice(current.cursor, 0, ...inserted);
                current.cursor += inserted.length;
            } else if (event.key === "enter") {
                const value = current.characters.join("");
                draft.current = { characters: [], cursor: 0 };
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
                        callbacks.onScroll("up", Infinity);
                        return;
                    }

                    current.cursor = start;
                } else if (event.key === "end") {
                    if (current.characters.length === 0) {
                        callbacks.onScroll("down", Infinity);
                        return;
                    }

                    current.cursor = end;
                } else if (event.key === "up") {
                    if (current.characters.length === 0) {
                        callbacks.onScroll("up", 1);
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
                        callbacks.onScroll("up", 1);
                        return;
                    }
                } else if (event.key === "down") {
                    if (current.characters.length === 0) {
                        callbacks.onScroll("down", 1);
                        return;
                    }

                    if (end < current.characters.length) {
                        const nextEnd = current.characters.indexOf("\n", end + 1);
                        current.cursor = Math.min(
                            nextEnd === -1 ? current.characters.length : nextEnd,
                            end + 1 + current.cursor - start,
                        );
                    } else {
                        callbacks.onScroll("down", 1);
                        return;
                    }
                }
            }

            redraw((value) => value + 1);
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
        Math.max(1, columns - 4),
        rows,
    );

    return (
        <Box flexDirection="column" height={rows} flexShrink={0}>
            {disabled ? (
                <Text wrap="truncate-end">
                    <Text color={palette.primary}>› </Text>
                    <Text dimColor>Working… Ctrl+C to cancel</Text>
                </Text>
            ) : (
                lines.map((line, index) => (
                    <Text key={index} wrap="truncate-end">
                        <Text color={palette.primary} bold>
                            {index === 0 ? "› " : "  "}
                        </Text>
                        {line.cursor === undefined ? (
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
                ))
            )}
        </Box>
    );
};
