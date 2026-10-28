import assert from "node:assert/strict";
import test from "node:test";
import {
    applyCredentialsToEnv,
    createCredentialsTemplate,
    isSecretKey,
    loadCredentialsFile,
    parseCredentialsEnv,
    redactObjectSecrets,
    redactSecret,
} from "../../src/config/credentials.js";

test("Credentials: parseCredentialsEnv parses key-value pairs, comments, and quotes", () => {
    const raw = `
# Comment line
GEMINI_API_KEY=test-gemini-key-123
export AKKCO_API_KEY="quoted-key-value"
SINGLE_QUOTED='single-quoted-secret'
WITH_SPACES = spaced-key-val
UNQUOTED_WITH_COMMENT=my-key-value # trailing comment
EMPTY_KEY=
`;
    const parsed = parseCredentialsEnv(raw);
    assert.strictEqual(parsed.GEMINI_API_KEY, "test-gemini-key-123");
    assert.strictEqual(parsed.AKKCO_API_KEY, "quoted-key-value");
    assert.strictEqual(parsed.SINGLE_QUOTED, "single-quoted-secret");
    assert.strictEqual(parsed.WITH_SPACES, "spaced-key-val");
    assert.strictEqual(parsed.UNQUOTED_WITH_COMMENT, "my-key-value");
    assert.strictEqual(parsed.EMPTY_KEY, "");
});

test("Credentials: applyCredentialsToEnv does NOT overwrite existing environment variables", () => {
    const targetEnv: NodeJS.ProcessEnv = {
        EXISTING_VAR: "original-shell-value",
        GEMINI_API_KEY: "shell-gemini-key",
    };

    const creds = {
        EXISTING_VAR: "file-var-value",
        GEMINI_API_KEY: "file-gemini-key",
        NEW_CREDENTIAL: "loaded-from-file",
    };

    const result = applyCredentialsToEnv(creds, targetEnv);

    // Existing variables must be preserved!
    assert.strictEqual(targetEnv.EXISTING_VAR, "original-shell-value");
    assert.strictEqual(targetEnv.GEMINI_API_KEY, "shell-gemini-key");
    assert.deepStrictEqual(result.preservedKeys, ["EXISTING_VAR", "GEMINI_API_KEY"]);

    // New variable must be loaded
    assert.strictEqual(targetEnv.NEW_CREDENTIAL, "loaded-from-file");
    assert.deepStrictEqual(result.addedKeys, ["NEW_CREDENTIAL"]);
});

test("Credentials: loadCredentialsFile returns empty when file does not exist", async () => {
    const res = await loadCredentialsFile("/nonexistent/credentials.env", {
        existsSync: () => false,
    });
    assert.strictEqual(res.exists, false);
    assert.deepStrictEqual(res.credentials, {});
});

test("Credentials: isSecretKey identifies secret-related keys case-insensitively", () => {
    assert.strictEqual(isSecretKey("GEMINI_API_KEY"), true);
    assert.strictEqual(isSecretKey("api_key"), true);
    assert.strictEqual(isSecretKey("AKKCO_API_KEY"), true);
    assert.strictEqual(isSecretKey("CLIENT_SECRET"), true);
    assert.strictEqual(isSecretKey("AUTH_TOKEN"), true);
    assert.strictEqual(isSecretKey("db_password"), true);
    assert.strictEqual(isSecretKey("credentials"), true);
    assert.strictEqual(isSecretKey("model_name"), false);
    assert.strictEqual(isSecretKey("window_tokens"), false);
    assert.strictEqual(isSecretKey("base_url"), false);
});

test("Credentials: redactSecret replaces non-empty secret with [REDACTED]", () => {
    assert.strictEqual(redactSecret("super-secret-key-12345"), "[REDACTED]");
    assert.strictEqual(redactSecret(""), "");
    assert.strictEqual(redactSecret(undefined), "");
    assert.strictEqual(redactSecret(null), "");
});

test("Credentials: redactObjectSecrets recursively redacts secrets", () => {
    const original = {
        model: {
            name: "qwen2.5-coder:7b",
            base_url: "http://localhost:11434/v1",
            api_key: "my-secret-key",
        },
        embedding: {
            provider: "gemini",
            api_key: "gemini-secret-123",
            api_key_env: "GEMINI_API_KEY",
        },
        context: {
            window_tokens: 32768,
        },
    };

    const redacted = redactObjectSecrets(original);

    // Verify secrets are redacted
    assert.strictEqual(redacted.model.api_key, "[REDACTED]");
    assert.strictEqual(redacted.embedding.api_key, "[REDACTED]");

    // Verify non-secret fields are preserved
    assert.strictEqual(redacted.model.name, "qwen2.5-coder:7b");
    assert.strictEqual(redacted.model.base_url, "http://localhost:11434/v1");
    assert.strictEqual(redacted.embedding.provider, "gemini");
    assert.strictEqual(redacted.embedding.api_key_env, "GEMINI_API_KEY");
    assert.strictEqual(redacted.context.window_tokens, 32768);

    // Original object was not mutated
    assert.strictEqual(original.model.api_key, "my-secret-key");
});

test("Credentials: createCredentialsTemplate does not overwrite existing file", async () => {
    let writeCalled = false;
    const res = await createCredentialsTemplate("/existing/credentials.env", {
        existsSync: () => true,
        mkdir: async () => {},
        writeFile: async () => {
            writeCalled = true;
        },
    });

    assert.strictEqual(res.created, false);
    assert.strictEqual(writeCalled, false);
});

test("Credentials: createCredentialsTemplate creates file with mode 0o600", async () => {
    let capturedMode: number | undefined;
    let capturedFlag: string | undefined;

    const res = await createCredentialsTemplate("/new/credentials.env", {
        existsSync: () => false,
        mkdir: async () => {},
        writeFile: async (_p, _content, opts) => {
            capturedMode = opts.mode;
            capturedFlag = opts.flag;
        },
    });

    assert.strictEqual(res.created, true);
    assert.strictEqual(capturedMode, 0o600);
    assert.strictEqual(capturedFlag, "wx");
});
