import { Box, Text } from "ink";
import { palette } from "../theme/palette.js";
import type { ConversationLine } from "../ui/layout.js";

const colors = {
    user: palette.primary,
    assistant: undefined,
    tool: palette.primary,
    success: palette.success,
    warning: palette.warning,
    error: palette.error,
    muted: palette.muted,
};

export const Conversation = ({
    lines,
    height,
    empty,
}: {
    lines: ConversationLine[];
    height: number;
    empty: boolean;
}) => {
    return (
        <Box
            flexDirection="column"
            height={height}
            flexShrink={0}
            paddingX={1}
            overflow="hidden"
            justifyContent={empty ? "center" : "flex-start"}
            alignItems={empty ? "center" : "stretch"}
        >
            {empty && height > 0 ? (
                <Text dimColor wrap="truncate-end">
                    Ask Akkco about this repository.
                </Text>
            ) : (
                lines.map((line, index) => (
                    <Text
                        key={index}
                        color={colors[line.tone]}
                        bold={line.bold}
                        dimColor={line.tone === "muted"}
                        wrap="truncate-end"
                    >
                        {line.text || " "}
                    </Text>
                ))
            )}
        </Box>
    );
};
