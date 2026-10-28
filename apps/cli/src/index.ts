import type { ModelProvider } from "@akkco/models";
import { createTextToolCompatibilityProvider, OpenAICompatibleProvider } from "@akkco/providers";
import { createRepositoryTools, createToolRegistry } from "@akkco/tools";
import { readFile } from "node:fs/promises";
import process, { stdin, stdout } from "node:process";
import { createDefaultCommandRegistry } from "./commands/command-registry.js";
import { handleConfigCommand } from "./commands/config-cli.js";
import {
    EmbeddingConfigurationError,
    resolveConfig,
    resolveEmbeddingProvider,
} from "./config/index.js";
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
    // Dispatch shell-level config management commands if requested
    const args = process.argv.slice(2);
    if (args[0] === "config") {
        const exitCode = await handleConfigCommand(args.slice(1));
        process.exit(exitCode);
    }

    const resolved = await resolveConfig({ cwd: process.cwd() });
    const effectiveConfig = resolved.config;
    const effectiveProfile = resolved.profile;
    const effectiveEnv = resolved.env;

    const model = effectiveConfig.model.name;
    const maxToolIterations = effectiveConfig.agent.max_tool_iterations;

    let nativeProvider: ModelProvider;
    let providerName = "OpenAICompatible";

    if (effectiveEnv.AKKCO_TEST_PROVIDER) {
        const testProviderModule =
            effectiveEnv.AKKCO_TEST_PROVIDER === "1" || effectiveEnv.AKKCO_TEST_PROVIDER === "true"
                ? await import("../test/pty/test-provider.js")
                : await import(effectiveEnv.AKKCO_TEST_PROVIDER);
        nativeProvider = testProviderModule.createDeterministicTestProvider();
        providerName = "DeterministicTestProvider";
    } else {
        nativeProvider = new OpenAICompatibleProvider({
            baseUrl: effectiveConfig.model.base_url,
            model,
            apiKey: effectiveConfig.model.api_key,
        });
    }

    const { createBoundedModelProvider, deriveContextBudget } = await import("@akkco/core");

    const boundedNativeProvider = createBoundedModelProvider(nativeProvider, {
        profile: effectiveProfile,
    });

    const provider =
        effectiveProfile.toolMode === "compatibility"
            ? createTextToolCompatibilityProvider(boundedNativeProvider)
            : boundedNativeProvider;

    const defaultProdDbPath = (await import("node:path")).join(
        (await import("node:os")).homedir(),
        ".akkco",
        "akkco.db",
    );

    const isTestMode = Boolean(
        effectiveEnv.AKKCO_TEST_PROVIDER ||
        effectiveEnv.AKKCO_TEST_MODE === "1" ||
        effectiveEnv.NODE_ENV === "test" ||
        effectiveEnv.NODE_TEST_CONTEXT,
    );

    let dbPath = effectiveEnv.AKKCO_DB_PATH;
    if (!dbPath) {
        dbPath = isTestMode ? ":memory:" : defaultProdDbPath;
    } else if (isTestMode && dbPath === defaultProdDbPath) {
        // Prevent inherited default production database path from polluting production during test execution
        dbPath = ":memory:";
    }

    let store: import("@akkco/retrieval").SqliteConversationStore | undefined;
    let orchestrator: import("@akkco/core").ConversationMemoryOrchestrator | undefined;
    let retriever: import("@akkco/core").DefaultConversationMemoryRetriever | undefined;

    const { SqliteConversationStore } = await import("@akkco/retrieval");
    store = new SqliteConversationStore({ dbPath });
    try {
        await store.initialize();
    } catch (error) {
        if (dbPath === ":memory:" || effectiveEnv.AKKCO_ALLOW_EPHEMERAL === "true") {
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
            embeddingProvider = await resolveEmbeddingProvider({
                env: effectiveEnv,
                config: effectiveConfig.embedding,
                modelConfig: effectiveConfig.model,
            });
        } catch (error) {
            if (error instanceof EmbeddingConfigurationError) {
                throw error;
            }
            throw new Error(
                `Failed to initialize embedding provider: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        const isDebug =
            effectiveEnv.AKKCO_EMBEDDING_DEBUG === "true" || effectiveEnv.AKKCO_DEBUG === "true";
        const { ConversationMemoryOrchestrator, DefaultConversationMemoryRetriever } =
            await import("@akkco/core");
        orchestrator = new ConversationMemoryOrchestrator(store, embeddingProvider, {
            debug: isDebug,
        });
        retriever = new DefaultConversationMemoryRetriever(store, embeddingProvider, {
            debug: isDebug,
        });
    }

    const manifest = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    const metadata: CliMetadata = {
        version: String(manifest.version),
        provider: providerName,
        model,
        toolMode: effectiveProfile.toolMode,
        cwd: process.cwd(),
    };

    const sessionId = effectiveEnv.AKKCO_SESSION_ID ?? (await import("node:crypto")).randomUUID();
    const contextBudget = deriveContextBudget(effectiveProfile);
    const { createBoundedContextCompiler, createContextCompactor } = await import("@akkco/core");
    const compactor = createContextCompactor({
        provider,
        profile: effectiveProfile,
        store: store ?? undefined,
    });
    const createCompiler = (id: string) =>
        createBoundedContextCompiler({
            budget: contextBudget,
            profile: effectiveProfile,
            memoryRetriever: retriever,
            compactor,
            sessionId: id,
        });
    const compiler = createCompiler(sessionId);

    const reliabilityOptions: import("@akkco/core").RuntimeReliabilityOptions = {};
    if (effectiveConfig.agent.max_tool_iterations !== undefined) {
        reliabilityOptions.maxToolIterations = effectiveConfig.agent.max_tool_iterations;
    }
    if (effectiveConfig.agent.repeated_tool_call_limit !== undefined) {
        reliabilityOptions.repeatedToolCallLimit = effectiveConfig.agent.repeated_tool_call_limit;
    }
    if (effectiveConfig.agent.consecutive_tool_error_limit !== undefined) {
        reliabilityOptions.consecutiveToolErrorLimit =
            effectiveConfig.agent.consecutive_tool_error_limit;
    }

    const controller = createCliController({
        provider,
        commandRegistry: createDefaultCommandRegistry(),
        toolRegistry: createToolRegistry(createRepositoryTools(process.cwd())),
        reliabilityOptions:
            Object.keys(reliabilityOptions).length > 0 ? reliabilityOptions : undefined,
        compiler,
        createCompiler,
        persistence: orchestrator,
        sessionId,
        profile: effectiveProfile,
        compactor,
        budget: contextBudget,
        store,
        metadata,
    });

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
        await orchestrator?.close();
        await store?.close().catch(() => {});
    }
};

void main().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
