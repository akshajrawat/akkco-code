import { Box, Text } from "ink";
import type { CliMetadata } from "../state/types.js";
import { palette } from "../theme/palette.js";
import { calculateLayout, displayDirectory, fitLine } from "../ui/layout.js";
import { Logo } from "./Logo.js";

export const Header = ({
    metadata,
    layout,
}: {
    metadata: CliMetadata;
    layout: ReturnType<typeof calculateLayout>;
}) => {
    if (!layout.headerHeight) {
        return null;
    }

    const centered = (text: string, color?: string) => {
        return (
            <Box justifyContent="center" flexShrink={0}>
                <Text color={color} wrap="truncate-end">
                    {fitLine(text, layout.width)}
                </Text>
            </Box>
        );
    };

    return (
        <Box flexDirection="column" height={layout.headerHeight} flexShrink={0}>
            {layout.blockLogo ? (
                <>
                    <Logo />
                    {centered(`Akkco Code v${metadata.version}`)}
                </>
            ) : (
                centered(`AKKCO CODE · v${metadata.version}`, palette.primary)
            )}

            {layout.headerHeight >= 4 && (
                <>
                    {centered(
                        `${metadata.model} · ${metadata.toolMode} · ${metadata.provider}`,
                        palette.secondary,
                    )}
                    {centered(displayDirectory(metadata.cwd), palette.muted)}
                </>
            )}

            <Text color={palette.muted}>{"─".repeat(layout.width)}</Text>
        </Box>
    );
};
