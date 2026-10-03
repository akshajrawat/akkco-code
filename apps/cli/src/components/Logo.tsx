import { Box, Text } from "ink";
import { palette } from "../theme/palette.js";

const glyphs = {
    A: ["▄▀▀▄", "█▄▄█", "█  █"],
    K: ["█ ▄▀", "█▀▄ ", "█ ▀▄"],
    C: ["▄▀▀▀", "█   ", "▀▄▄▄"],
    O: ["▄▀▀▄", "█  █", "▀▄▄▀"],
    D: ["█▀▀▄", "█  █", "█▄▄▀"],
    E: ["█▀▀▀", "█▀▀ ", "█▄▄▄"],
};

const akkco = [0, 1, 2].map((row) =>
    [..."AKKCO"].map((letter) => glyphs[letter as keyof typeof glyphs][row]).join(" "),
);

const code = [0, 1, 2].map((row) =>
    [..."CODE"].map((letter) => glyphs[letter as keyof typeof glyphs][row]).join(" "),
);

export const Logo = () => {
    return (
        <Box flexDirection="column" alignItems="center" flexShrink={0}>
            {akkco.map((row, index) => (
                <Text key={index}>
                    <Text color={palette.primary}>{row}</Text>
                    {"   "}
                    <Text color={palette.secondary}>{code[index]}</Text>
                </Text>
            ))}
        </Box>
    );
};
