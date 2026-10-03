import { Box, Text } from "ink";
import type { CommandMetadata } from "../commands/command-registry.js";
import { palette } from "../theme/palette.js";
import { fitLine } from "../ui/layout.js";

export type CommandSuggestionsProps = {
    commands: readonly CommandMetadata[];
    selectedIndex: number;
    width: number;
    maxVisible?: number;
};

export const CommandSuggestions = ({
    commands,
    selectedIndex,
    width,
    maxVisible = 5,
}: CommandSuggestionsProps) => {
    if (commands.length === 0) {
        return null;
    }

    const boxWidth = Math.max(1, width);
    const visibleCount = Math.min(commands.length, maxVisible);

    // Compute windowing offset so that selectedIndex is always within the visible slice
    let startIndex = 0;
    if (selectedIndex >= visibleCount) {
        startIndex = Math.min(selectedIndex - visibleCount + 1, commands.length - visibleCount);
    }
    const visibleCommands = commands.slice(startIndex, startIndex + visibleCount);

    // Top border: ┌ Commands ───────────────────
    const headerPrefix = "┌ Commands ";
    const topDashes = "─".repeat(Math.max(0, boxWidth - headerPrefix.length));
    const topBorder = fitLine(`${headerPrefix}${topDashes}`, boxWidth);

    // Bottom border: └────────────────────────── or └─ 3/8 ────────────
    let bottomBorder: string;
    if (commands.length > visibleCount) {
        const indicator = ` ${selectedIndex + 1}/${commands.length} `;
        const remainingDashes = "─".repeat(Math.max(0, boxWidth - 2 - indicator.length));
        bottomBorder = fitLine(`└─${indicator}${remainingDashes}`, boxWidth);
    } else {
        bottomBorder = fitLine(`└${"─".repeat(Math.max(0, boxWidth - 1))}`, boxWidth);
    }

    // Determine command name column width based on visible commands
    const maxNameLen = Math.max(...commands.map((c) => c.name.length + 1));
    const nameColWidth = Math.min(16, Math.max(8, maxNameLen + 2));

    return (
        <Box flexDirection="column" width={boxWidth}>
            <Text color={palette.muted} wrap="truncate-end">
                {topBorder}
            </Text>

            {visibleCommands.map((command, idx) => {
                const actualIndex = startIndex + idx;
                const isSelected = actualIndex === selectedIndex;
                const cmdName = `/${command.name}`;
                const paddedName = cmdName.padEnd(nameColWidth);

                // Responsive content layout:
                // Very narrow (< 35): only command name
                // Medium (35 - 74): command name + description
                // Wide (>= 75): command name + description + usage
                const showUsage = boxWidth >= 75 && Boolean(command.usage);
                const showDescription = boxWidth >= 35;

                const leftBorder = "│ ";
                const borderLen = 2;

                if (!showDescription) {
                    return (
                        <Text key={command.name} wrap="truncate-end">
                            <Text color={palette.muted}>{leftBorder}</Text>
                            <Text
                                color={isSelected ? palette.primary : palette.secondary}
                                bold={isSelected}
                            >
                                {fitLine(cmdName, boxWidth - borderLen)}
                            </Text>
                        </Text>
                    );
                }

                if (showUsage && command.usage) {
                    const usageLen = Math.min(26, Math.max(10, command.usage.length + 2));
                    const descAvailable = Math.max(
                        10,
                        boxWidth - borderLen - nameColWidth - usageLen - 2,
                    );
                    const fittedDesc = fitLine(command.description, descAvailable).padEnd(
                        descAvailable,
                    );
                    const fittedUsage = fitLine(command.usage, usageLen);

                    return (
                        <Text key={command.name} wrap="truncate-end">
                            <Text color={palette.muted}>{leftBorder}</Text>
                            <Text
                                color={isSelected ? palette.primary : palette.secondary}
                                bold={isSelected}
                            >
                                {paddedName}
                            </Text>
                            <Text color={palette.muted}> {fittedDesc} </Text>
                            <Text color={palette.muted} dimColor>
                                {fittedUsage}
                            </Text>
                        </Text>
                    );
                }

                const descAvailable = Math.max(1, boxWidth - borderLen - nameColWidth - 1);
                const fittedDesc = fitLine(command.description, descAvailable);

                return (
                    <Text key={command.name} wrap="truncate-end">
                        <Text color={palette.muted}>{leftBorder}</Text>
                        <Text
                            color={isSelected ? palette.primary : palette.secondary}
                            bold={isSelected}
                        >
                            {paddedName}
                        </Text>
                        <Text color={palette.muted}>{fittedDesc}</Text>
                    </Text>
                );
            })}

            <Text color={palette.muted} wrap="truncate-end">
                {bottomBorder}
            </Text>
        </Box>
    );
};
