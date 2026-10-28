import fs from "node:fs";
import fsp from "node:fs/promises";
import { parse } from "smol-toml";
import { validateConfig, validateProjectConfig } from "./schema.js";
import type { AkkcoConfig } from "./types.js";

export class ConfigParseError extends Error {
    constructor(
        message: string,
        public readonly filePath: string,
    ) {
        super(message);
        this.name = "ConfigParseError";
    }
}

export interface LoadConfigFileOptions {
    readonly isProject?: boolean;
    readonly existsSync?: (p: string) => boolean;
    readonly readFile?: (p: string, enc: BufferEncoding) => Promise<string>;
}

/**
 * Loads and validates a TOML configuration file.
 * Returns empty config if the file does not exist.
 * Throws ConfigParseError on invalid TOML, ConfigValidationError on schema mismatch,
 * and ConfigSecurityError if project config contains disallowed settings.
 */
export const loadConfigFile = async (
    filePath: string,
    options?: LoadConfigFileOptions,
): Promise<{ config: AkkcoConfig; exists: boolean }> => {
    const existsSync = options?.existsSync ?? fs.existsSync;
    const readFile = options?.readFile ?? fsp.readFile;

    if (!existsSync(filePath)) {
        return { config: {}, exists: false };
    }

    let content: string;
    try {
        content = await readFile(filePath, "utf8");
    } catch (error) {
        throw new Error(
            `Failed to read configuration file at "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    let parsed: unknown;
    try {
        parsed = parse(content);
    } catch (error) {
        throw new ConfigParseError(
            `Failed to parse TOML configuration at "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
            filePath,
        );
    }

    const validated = options?.isProject
        ? validateProjectConfig(parsed, filePath)
        : validateConfig(parsed, `configuration file (${filePath})`);

    return { config: validated, exists: true };
};
