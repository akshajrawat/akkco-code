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

export const Conversation = ({ lines }: { lines: ConversationLine[] }) => (
    <Box flexDirection="column" flexShrink={0} paddingX={1}>
        {lines.map((line, index) => (
            <Text
                key={index}
                color={colors[line.tone]}
                bold={line.bold}
                dimColor={line.tone === "muted"}
                wrap="truncate-end"
            >
                {line.text || " "}
            </Text>
        ))}
    </Box>
);
