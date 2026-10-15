import type { ModelProvider } from "@akkco/models";
import { createTextToolCompatibilityProvider, OpenAICompatibleProvider } from "@akkco/providers";
import { createRepositoryTools, createToolRegistry } from "@akkco/tools";
import { readFile } from "node:fs/promises";
import process, { stdin, stdout } from "node:process";
import { DEFAULT_MODEL, parseMaxToolIterations, parseToolMode } from "./config.js";
import { runPlainCli } from "./plain-cli.js";
import { createCliController } from "./state/cli-controller.js";
import type { CliMetadata } from "./state/types.js";

const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...args: unknown[]) {
    if (typeof warning === "string" && warning.includes("SQLite")) {
        return;
    }
    if (
        warning &&
        typeof warning === "object" &&
        "message" in warning &&
        typeof (warning as { message: unknown }).message === "string" &&
        (warning as { message: string }).message.includes("SQLite")
    ) {
        return;
    }
    return Reflect.apply(origEmitWarning, process, [warning, ...args]);
};

const main = async () => {
    const toolMode = parseToolMode(process.env.AKKCO_TOOL_MODE);
    const maxToolIterations = parseMaxToolIterations(process.env.AKKCO_MAX_TOOL_ITERATIONS);

    const model = process.env.AKKCO_MODEL ?? DEFAULT_MODEL;
    let nativeProvider: ModelProvider;
    let providerName = "OpenAICompatible";

    if (process.env.AKKCO_TEST_PROVIDER) {
        const testProviderModule =
            process.env.AKKCO_TEST_PROVIDER === "1" || process.env.AKKCO_TEST_PROVIDER === "true"
                ? await import("../test/pty/test-provider.js")
                : await import(process.env.AKKCO_TEST_PROVIDER);
        nativeProvider = testProviderModule.createDeterministicTestProvider();
        providerName = "DeterministicTestProvider";
    } else {
        nativeProvider = new OpenAICompatibleProvider({
            baseUrl: process.env.AKKCO_BASE_URL ?? "http://localhost:11434/v1",
            model,
            apiKey: process.env.AKKCO_API_KEY,
        });
    }

    const { prepareBoundedModelRequest, DEFAULT_CONTEXT_BUDGET } = await import("@akkco/core");

    const provider =
        toolMode === "compatibility"
            ? createTextToolCompatibilityProvider(nativeProvider, {
                  prepareRequest: (req) =>
                      prepareBoundedModelRequest({
                          request: req,
                          budget: DEFAULT_CONTEXT_BUDGET,
                      }),
              })
            : nativeProvider;

    const isTestMode = Boolean(
        process.env.AKKCO_TEST_PROVIDER ||
        process.env.NODE_ENV === "test" ||
        process.env.NODE_TEST_CONTEXT,
    );

    const dbPath =
        process.env.AKKCO_DB_PATH ??
        (isTestMode
            ? ":memory:"
            : (await import("node:path")).join(
                  (await import("node:os")).homedir(),
                  ".akkco",
                  "akkco.db",
              ));

    let store: import("@akkco/retrieval").SqliteConversationStore | undefined;
    let orchestrator: import("@akkco/core").ConversationMemoryOrchestrator | undefined;
    let retriever: import("@akkco/core").DefaultConversationMemoryRetriever | undefined;

    const { SqliteConversationStore } = await import("@akkco/retrieval");
    store = new SqliteConversationStore({ dbPath });
    try {
        await store.initialize();
    } catch (error) {
        if (dbPath === ":memory:" || process.env.AKKCO_ALLOW_EPHEMERAL === "true") {
            store = undefined;
        } else {
            throw new Error(
                `Failed to initialize SQLite database at "${dbPath}": ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    if (store) {
        let embeddingProvider: import("@akkco/models").EmbeddingProvider | undefined;
        try {
            if (process.env.AKKCO_TEST_PROVIDER) {
                const { DeterministicFakeEmbeddingProvider } =
                    await import("@akkco/models/testing");
                embeddingProvider = new DeterministicFakeEmbeddingProvider();
            } else if (process.env.AKKCO_EMBEDDING_MODEL) {
                const { OpenAICompatibleEmbeddingProvider } = await import("@akkco/providers");
                embeddingProvider = new OpenAICompatibleEmbeddingProvider({
                    baseUrl:
                        process.env.AKKCO_EMBEDDING_BASE_URL ??
                        process.env.AKKCO_BASE_URL ??
                        "http://localhost:11434/v1",
                    model: process.env.AKKCO_EMBEDDING_MODEL,
                    apiKey: process.env.AKKCO_EMBEDDING_API_KEY ?? process.env.AKKCO_API_KEY,
                });
            }
        } catch {
            // Graceful degradation: embedding provider setup error falls back to keyword memory
        }

        const { ConversationMemoryOrchestrator, DefaultConversationMemoryRetriever } =
            await import("@akkco/core");
        orchestrator = new ConversationMemoryOrchestrator(store, embeddingProvider);
        retriever = new DefaultConversationMemoryRetriever(store, embeddingProvider);
    }

    const sessionId = process.env.AKKCO_SESSION_ID ?? (await import("node:crypto")).randomUUID();
    const { createBoundedContextCompiler } = await import("@akkco/core");
    const compiler = createBoundedContextCompiler({
        budget: DEFAULT_CONTEXT_BUDGET,
        memoryRetriever: retriever,
        sessionId,
    });

    const controller = createCliController({
        provider,
        toolRegistry: createToolRegistry(createRepositoryTools(process.cwd())),
        reliabilityOptions: maxToolIterations !== undefined ? { maxToolIterations } : undefined,
        compiler,
        persistence: orchestrator,
        sessionId,
    });

    const manifest = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    const metadata: CliMetadata = {
        version: String(manifest.version),
        provider: providerName,
        model,
        toolMode,
        cwd: process.cwd(),
    };

    const onSigint = () => {
        controller.interrupt();
    };
    const onSigterm = () => {
        controller.interrupt();
        void controller.dispose();
    };

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    try {
        if (
            stdin.isTTY &&
            stdout.isTTY &&
            typeof stdin.setRawMode === "function" &&
            process.env.TERM !== "dumb"
        ) {
            const { runInteractiveCli } = await import("./app.js");
            await runInteractiveCli(controller, metadata);
        } else {
            await runPlainCli(controller, metadata);
        }
    } finally {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        await controller.dispose();
        await orchestrator?.waitForPendingIndexing(2000);
        await store?.close().catch(() => {});
    }
};

void main().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
