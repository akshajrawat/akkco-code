import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Checks if a key name represents a secret credential.
 */
export const isSecretKey = (key: string): boolean => {
    const normalized = key.toLowerCase();
    // Non-secret metadata keys that happen to contain keywords
    if (
        normalized.includes("tokens") ||
        normalized.endsWith("_tokens") ||
        normalized.endsWith("_env") ||
        normalized.endsWith("env")
    ) {
        return false;
    }
    return (
        normalized.includes("key") ||
        normalized.includes("secret") ||
        normalized.includes("token") ||
        normalized.includes("password") ||
        normalized.includes("credential") ||
        normalized.includes("auth")
    );
};

/**
 * Redacts a secret value to "[REDACTED]" if present.
 */
export const redactSecret = (value: unknown): string => {
    if (value === undefined || value === null) {
        return "";
    }
    const str = String(value);
    return str.length > 0 ? "[REDACTED]" : "";
};

/**
 * Recursively creates a copy of an object with any secret keys redacted.
 */
export const redactObjectSecrets = <T>(obj: T): T => {
    if (obj === null || obj === undefined || typeof obj !== "object") {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map((item) => redactObjectSecrets(item)) as unknown as T;
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (isSecretKey(key)) {
            result[key] = val ? "[REDACTED]" : val;
        } else if (typeof val === "object" && val !== null) {
            result[key] = redactObjectSecrets(val);
        } else {
            result[key] = val;
        }
    }

    return result as T;
};

/**
 * Parses simple dotenv-style content safely without external dependencies.
 */
export const parseCredentialsEnv = (content: string): Record<string, string> => {
    const result: Record<string, string> = {};
    const lines = content.split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();

        // Skip blank lines and full comments
        if (!line || line.startsWith("#")) {
            continue;
        }

        // Strip optional leading 'export '
        const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;

        const equalsIndex = withoutExport.indexOf("=");
        if (equalsIndex === -1) {
            continue;
        }

        const key = withoutExport.slice(0, equalsIndex).trim();
        let value = withoutExport.slice(equalsIndex + 1).trim();

        if (!key) {
            continue;
        }

        // Handle quoted values
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        } else {
            // Strip trailing unquoted comments if preceded by whitespace
            const commentIndex = value.search(/\s+#/);
            if (commentIndex !== -1) {
                value = value.slice(0, commentIndex).trim();
            }
        }

        result[key] = value;
    }

    return result;
};

/**
 * Loads credentials from the specified file if it exists.
 * Does not throw if the file does not exist.
 */
export const loadCredentialsFile = async (
    credentialsPath: string,
    options?: {
        readonly existsSync?: (p: string) => boolean;
        readonly readFile?: (p: string, enc: BufferEncoding) => Promise<string>;
    },
): Promise<{ credentials: Record<string, string>; exists: boolean }> => {
    const existsSync = options?.existsSync ?? fs.existsSync;
    const readFile = options?.readFile ?? fsp.readFile;

    if (!existsSync(credentialsPath)) {
        return { credentials: {}, exists: false };
    }

    try {
        const content = await readFile(credentialsPath, "utf8");
        const credentials = parseCredentialsEnv(content);
        return { credentials, exists: true };
    } catch (error) {
        throw new Error(
            `Failed to read credentials file at "${credentialsPath}": ${error instanceof Error ? error.message : String(error)}`,
        );
    }
};

/**
 * Injects credentials into the target environment without overwriting
 * existing environment variables. Existing shell variables strictly take precedence.
 */
export const applyCredentialsToEnv = (
    credentials: Record<string, string>,
    targetEnv: NodeJS.ProcessEnv = process.env,
): { addedKeys: string[]; preservedKeys: string[] } => {
    const addedKeys: string[] = [];
    const preservedKeys: string[] = [];

    for (const [key, value] of Object.entries(credentials)) {
        if (targetEnv[key] === undefined || targetEnv[key] === "") {
            targetEnv[key] = value;
            addedKeys.push(key);
        } else {
            preservedKeys.push(key);
        }
    }

    return { addedKeys, preservedKeys };
};

/**
 * Creates starter credentials template with restrictive POSIX permissions (0o600).
 */
export const createCredentialsTemplate = async (
    filePath: string,
    options?: {
        readonly existsSync?: (p: string) => boolean;
        readonly mkdir?: (
            p: string,
            opts: { recursive: boolean; mode?: number },
        ) => Promise<unknown>;
        readonly writeFile?: (
            p: string,
            content: string,
            opts: { mode?: number; flag?: string },
        ) => Promise<unknown>;
    },
): Promise<{ created: boolean; path: string }> => {
    const existsSync = options?.existsSync ?? fs.existsSync;
    const mkdir = options?.mkdir ?? fsp.mkdir;
    const writeFile = options?.writeFile ?? fsp.writeFile;

    if (existsSync(filePath)) {
        return { created: false, path: filePath };
    }

    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const templateContent = [
        "# AKKCO Code Private Credentials",
        "# Stored securely alongside global config. Never commit this file.",
        "",
        '# Google Gemini API Key (required when embedding.provider = "gemini")',
        "# GEMINI_API_KEY=",
        "",
        "# OpenAI-compatible API Key (optional for authenticated remote proxies)",
        "# AKKCO_API_KEY=",
        "# AKKCO_EMBEDDING_API_KEY=",
        "",
    ].join("\n");

    await writeFile(filePath, templateContent, { mode: 0o600, flag: "wx" });
    return { created: true, path: filePath };
};
