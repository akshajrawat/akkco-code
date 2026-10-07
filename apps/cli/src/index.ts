import type { ModelProvider } from "@akkco/models";
import { createTextToolCompatibilityProvider, OpenAICompatibleProvider } from "@akkco/providers";
import { createRepositoryTools, createToolRegistry } from "@akkco/tools";
import { readFile } from "node:fs/promises";
import process, { stdin, stdout } from "node:process";
import { DEFAULT_MODEL, parseMaxToolIterations, parseToolMode } from "./config.js";
import { runPlainCli } from "./plain-cli.js";
import { createCliController } from "./state/cli-controller.js";
import type { CliMetadata } from "./state/types.js";

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

    const provider =
        toolMode === "compatibility"
            ? createTextToolCompatibilityProvider(nativeProvider)
            : nativeProvider;

    const controller = createCliController({
        provider,
        toolRegistry: createToolRegistry(createRepositoryTools(process.cwd())),
        reliabilityOptions: maxToolIterations !== undefined ? { maxToolIterations } : undefined,
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

    process.on("SIGINT", controller.interrupt);

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
        process.off("SIGINT", controller.interrupt);
        controller.dispose();
    }
};

void main().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
