import type { CommandMetadata } from "../commands/command-registry.js";

/**
 * Extracts the current slash command prefix if the prompt is an in-progress command.
 * Returns null if the prompt is not a slash command, or if the cursor is past the command name into arguments.
 */
export const getCommandPrefix = (text: string, cursor: number): string | null => {
    const trimmedStart = text.trimStart();
    if (!trimmedStart.startsWith("/")) {
        return null;
    }

    const leadingSpaces = text.length - trimmedStart.length;
    if (cursor < leadingSpaces + 1) {
        return null;
    }

    // Text between the slash and the cursor
    const betweenSlashAndCursor = text.slice(leadingSpaces + 1, cursor);
    if (/\s/.test(betweenSlashAndCursor)) {
        return null;
    }

    // Command token in the draft
    const afterSlash = text.slice(leadingSpaces + 1);
    const spaceIndex = afterSlash.search(/\s/);
    const commandToken = spaceIndex === -1 ? afterSlash : afterSlash.slice(0, spaceIndex);

    // If cursor is past the command token (e.g. into arguments after whitespace), hide suggestions
    if (cursor > leadingSpaces + 1 + commandToken.length) {
        return null;
    }

    // Return the typed prefix up to the cursor
    return betweenSlashAndCursor.toLowerCase();
};

/**
 * Filters commands whose name starts with the given prefix (case-insensitive), sorted alphabetically.
 */
export const filterCommands = (
    commands: readonly CommandMetadata[],
    prefix: string,
): CommandMetadata[] => {
    const normalizedPrefix = prefix.replace(/^\//, "").toLowerCase().trim();
    const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));

    if (!normalizedPrefix) {
        return sorted;
    }

    return sorted.filter((cmd) =>
        cmd.name.replace(/^\//, "").toLowerCase().startsWith(normalizedPrefix),
    );
};

/**
 * Determines whether a command expects arguments based on its usage metadata.
 */
export const commandExpectsArguments = (command: CommandMetadata): boolean => {
    if (!command.usage) {
        return false;
    }

    const cleanUsage = command.usage.trim().replace(/^\//, "");
    const cleanName = command.name.trim().replace(/^\//, "");

    return cleanUsage.length > cleanName.length;
};

/**
 * Applies completion for the selected command into the prompt draft.
 */
export const applyCompletion = (
    text: string,
    _cursor: number,
    command: CommandMetadata,
): { text: string; cursor: number } => {
    const trimmedStart = text.trimStart();
    const leadingSpaces = text.slice(0, text.length - trimmedStart.length);
    const afterSlash = trimmedStart.replace(/^\//, "");
    const spaceIndex = afterSlash.search(/\s/);

    const remainder = spaceIndex === -1 ? "" : afterSlash.slice(spaceIndex);
    const cleanName = command.name.replace(/^\//, "");
    const expectsArgs = commandExpectsArguments(command);

    // If expects arguments and there are no existing arguments, append a trailing space
    const trailingSpace = expectsArgs && !remainder ? " " : "";
    const completedCommand = `/${cleanName}${trailingSpace}`;

    const newText = `${leadingSpaces}${completedCommand}${remainder}`;
    const newCursor = leadingSpaces.length + completedCommand.length;

    return { text: newText, cursor: newCursor };
};

/**
 * Wraps or advances the selected index when navigating up or down.
 */
export const getNextSelection = (
    current: number,
    total: number,
    direction: "up" | "down",
): number => {
    if (total <= 0) {
        return 0;
    }

    if (direction === "down") {
        return (current + 1) % total;
    }

    return (current - 1 + total) % total;
};

/**
 * Calculates the height in rows of the suggestions box.
 * Top border (1) + visible items + bottom border (1).
 */
export const calculateSuggestionsHeight = (totalItems: number, maxVisible = 5): number => {
    if (totalItems <= 0) {
        return 0;
    }

    const visibleCount = Math.min(totalItems, maxVisible);
    return visibleCount + 2;
};
