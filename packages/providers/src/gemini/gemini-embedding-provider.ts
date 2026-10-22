import type { EmbeddingOptions, EmbeddingProvider } from "@akkco/models";

export interface GeminiEmbeddingConfig {
    readonly apiKey: string;
    readonly model?: string;
    readonly dimensions?: number;
    readonly baseUrl?: string;
    readonly taskType?: string;
    readonly maxRetries?: number;
    readonly timeoutMs?: number;
    readonly overallTimeoutBudgetMs?: number;
    readonly autoTruncate?: boolean;
    readonly maxInputTokens?: number;
    readonly fetch?: typeof globalThis.fetch;
}

const BATCH_SIZE = 100;

/**
 * Conservative token estimation for Gemini embedding inputs, accounting for
 * multi-byte Unicode code points, CJK characters, and code symbols.
 */
export const estimateTokensForGemini = (text: string): number => {
    if (!text) {
        return 0;
    }
    let tokens = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code > 0x7f) {
            tokens += 1.5;
        } else if (/[ \t\n{}()[\];:,.<>+=!*&|~^/%-]/.test(char)) {
            tokens += 0.8;
        } else {
            tokens += 0.3;
        }
    }
    return Math.ceil(tokens);
};

/**
 * Concrete embedding provider integrating Google's Gemini Embedding API with
 * configurable output dimensionality, batching, bounded retries, and cancellation.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
    readonly id = "gemini";
    readonly model: string;
    readonly dimensions: number;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly overallTimeoutBudgetMs: number;
    readonly autoTruncate: boolean;
    readonly maxInputTokens: number;
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly taskType?: string;
    private readonly fetch: typeof globalThis.fetch;

    constructor(config: GeminiEmbeddingConfig) {
        if (!config.apiKey || typeof config.apiKey !== "string" || !config.apiKey.trim()) {
            throw new Error("Gemini API key is required");
        }
        this.apiKey = config.apiKey.trim();

        if (config.model !== undefined) {
            if (typeof config.model !== "string" || !config.model.trim()) {
                throw new Error("Gemini embedding model name must not be empty");
            }
            this.model = config.model.trim();
        } else {
            this.model = "gemini-embedding-001";
        }

        if (config.dimensions !== undefined) {
            if (
                typeof config.dimensions !== "number" ||
                !Number.isInteger(config.dimensions) ||
                config.dimensions <= 0
            ) {
                throw new Error("Gemini embedding dimensions must be a positive integer");
            }
            this.dimensions = config.dimensions;
        } else {
            this.dimensions = 768;
        }

        this.baseUrl = (config.baseUrl ?? "https://generativelanguage.googleapis.com")
            .trim()
            .replace(/\/+$/, "");
        this.taskType = config.taskType;
        this.maxRetries =
            typeof config.maxRetries === "number" && config.maxRetries >= 0 ? config.maxRetries : 2;
        this.timeoutMs =
            typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 10000;
        this.overallTimeoutBudgetMs =
            typeof config.overallTimeoutBudgetMs === "number" && config.overallTimeoutBudgetMs > 0
                ? config.overallTimeoutBudgetMs
                : (this.maxRetries + 1) * this.timeoutMs + this.maxRetries * 5000;
        this.autoTruncate = config.autoTruncate ?? false;
        this.maxInputTokens =
            typeof config.maxInputTokens === "number" && config.maxInputTokens > 0
                ? config.maxInputTokens
                : 2048;
        this.fetch = config.fetch ?? globalThis.fetch;
    }

    /**
     * Bounds input text so its output strictly satisfies its configured token-estimation budget.
     * Preserves head and tail context with an explicit truncation delimiter without splitting
     * multi-byte surrogate pairs, handling code-heavy text, CJK, emoji, and extremely long strings.
     */
    boundInput = (text: string): string => {
        const estimatedTokens = estimateTokensForGemini(text);
        if (estimatedTokens <= this.maxInputTokens) {
            return text;
        }

        const delimiter = `\n\n[... content truncated for embedding: exceeds ${this.maxInputTokens} token limit ...]\n\n`;
        const delimiterTokens = estimateTokensForGemini(delimiter);
        const availableTokens = Math.max(10, this.maxInputTokens - delimiterTokens);

        // Split available token budget between head (50%) and tail (50%)
        const headTargetTokens = Math.floor(availableTokens * 0.5);
        const tailTargetTokens = availableTokens - headTargetTokens;

        // Extract head code points respecting headTargetTokens
        const headParts: string[] = [];
        let headTokens = 0;
        for (const char of text) {
            const charTokens =
                (char.codePointAt(0) ?? 0) > 0x7f
                    ? 1.5
                    : /[ \t\n{}()[\];:,.<>+=!*&|~^/%-]/.test(char)
                      ? 0.8
                      : 0.3;
            if (headTokens + charTokens > headTargetTokens) {
                break;
            }
            headParts.push(char);
            headTokens += charTokens;
        }

        // Extract tail code points scanning backwards from end of string without creating huge arrays
        const tailParts: string[] = [];
        let tailTokens = 0;
        let index = text.length;

        while (index > 0) {
            // Check if previous char is a low surrogate (part of surrogate pair)
            let charLength = 1;
            const code = text.charCodeAt(index - 1);
            if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
                const prevCode = text.charCodeAt(index - 2);
                if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
                    charLength = 2;
                }
            }
            const char = text.slice(index - charLength, index);
            const charTokens =
                (char.codePointAt(0) ?? 0) > 0x7f
                    ? 1.5
                    : /[ \t\n{}()[\];:,.<>+=!*&|~^/%-]/.test(char)
                      ? 0.8
                      : 0.3;
            if (tailTokens + charTokens > tailTargetTokens) {
                break;
            }
            tailParts.unshift(char);
            tailTokens += charTokens;
            index -= charLength;
        }

        let result = `${headParts.join("")}${delimiter}${tailParts.join("")}`;

        // Invariant guard: strictly guarantee estimateTokensForGemini(result) <= this.maxInputTokens
        while (estimateTokensForGemini(result) > this.maxInputTokens) {
            if (tailParts.length > 0) {
                tailParts.shift();
            } else if (headParts.length > 0) {
                headParts.pop();
            } else {
                break;
            }
            result = `${headParts.join("")}${delimiter}${tailParts.join("")}`;
        }

        return result;
    };

    private sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
        if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (signal) {
                    signal.removeEventListener("abort", onAbort);
                }
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                reject(new DOMException("The operation was aborted.", "AbortError"));
            };
            if (signal) {
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
    };

    private calculateBackoff = (attempt: number, retryAfterHeader?: string | null): number => {
        if (retryAfterHeader) {
            const seconds = parseInt(retryAfterHeader, 10);
            if (!isNaN(seconds) && seconds > 0) {
                return Math.min(seconds * 1000, 10000);
            }
        }
        const base = 200 * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 100);
        return Math.min(base + jitter, 5000);
    };

    private sanitizeErrorDetails = (text: string): string => {
        if (!text || !this.apiKey) {
            return text;
        }
        return text.replaceAll(this.apiKey, "[REDACTED]");
    };

    embed = async (
        inputs: readonly string[],
        signal?: AbortSignal,
        options?: EmbeddingOptions,
    ): Promise<number[][]> => {
        if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        if (inputs.length === 0) {
            return [];
        }

        const cleanModel = this.model.replace(/^models\//, "");
        const url = this.baseUrl.endsWith("/v1beta")
            ? `${this.baseUrl}/models/${cleanModel}:batchEmbedContents`
            : `${this.baseUrl}/v1beta/models/${cleanModel}:batchEmbedContents`;

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
        };

        const allResults: number[][] = [];

        for (let batchStart = 0; batchStart < inputs.length; batchStart += BATCH_SIZE) {
            const batch = inputs.slice(batchStart, batchStart + BATCH_SIZE);

            const requests = batch.map((text) => {
                const boundedText = this.boundInput(text);
                const req: Record<string, unknown> = {
                    model: `models/${cleanModel}`,
                    content: {
                        parts: [{ text: boundedText }],
                    },
                };
                if (this.autoTruncate) {
                    req.autoTruncate = true;
                }
                if (this.dimensions !== undefined) {
                    req.outputDimensionality = this.dimensions;
                }
                const effectiveTaskType = options?.taskType ?? this.taskType;
                if (effectiveTaskType) {
                    req.taskType = effectiveTaskType;
                }
                if (options?.title) {
                    req.title = options.title;
                }
                return req;
            });

            const body = JSON.stringify({ requests });
            const batchStartTime = Date.now();

            let attempt = 0;
            while (true) {
                if (signal?.aborted) {
                    throw new DOMException("The operation was aborted.", "AbortError");
                }

                const elapsed = Date.now() - batchStartTime;
                const remainingOverallMs = this.overallTimeoutBudgetMs - elapsed;
                if (remainingOverallMs <= 0) {
                    throw new Error(
                        `Gemini embedding request exceeded overall timeout budget of ${this.overallTimeoutBudgetMs}ms across attempts`,
                    );
                }

                const currentAttemptTimeoutMs = Math.min(this.timeoutMs, remainingOverallMs);
                const timeoutController = new AbortController();
                const timer = setTimeout(() => {
                    timeoutController.abort(
                        new Error(
                            `Gemini embedding request timed out after ${currentAttemptTimeoutMs}ms`,
                        ),
                    );
                }, currentAttemptTimeoutMs);

                const onCallerAbort = () => {
                    timeoutController.abort(
                        signal?.reason ??
                            new DOMException("The operation was aborted.", "AbortError"),
                    );
                };

                if (signal) {
                    signal.addEventListener("abort", onCallerAbort, { once: true });
                }

                let response: Response;
                try {
                    response = await this.fetch(url, {
                        method: "POST",
                        headers,
                        body,
                        signal: timeoutController.signal,
                    });
                } catch (fetchError) {
                    clearTimeout(timer);
                    if (signal) {
                        signal.removeEventListener("abort", onCallerAbort);
                    }
                    if (signal?.aborted) {
                        throw new DOMException("The operation was aborted.", "AbortError");
                    }
                    const canRetry =
                        attempt < this.maxRetries &&
                        Date.now() - batchStartTime < this.overallTimeoutBudgetMs;
                    if (timeoutController.signal.aborted && !signal?.aborted) {
                        if (canRetry) {
                            attempt++;
                            const delay = this.calculateBackoff(attempt);
                            await this.sleep(delay, signal);
                            continue;
                        }
                        throw new Error(
                            `Gemini embedding request timed out after ${currentAttemptTimeoutMs}ms`,
                        );
                    }
                    if (canRetry) {
                        attempt++;
                        const delay = this.calculateBackoff(attempt);
                        await this.sleep(delay, signal);
                        continue;
                    }
                    throw new Error(
                        `Gemini embedding network request failed: ${fetchError instanceof Error ? this.sanitizeErrorDetails(fetchError.message) : String(fetchError)}`,
                    );
                } finally {
                    clearTimeout(timer);
                    if (signal) {
                        signal.removeEventListener("abort", onCallerAbort);
                    }
                }

                if (!response.ok) {
                    let errorDetails = "";
                    try {
                        const errJson = await response.json();
                        if (errJson && typeof errJson === "object" && "error" in errJson) {
                            const errObj = (errJson as { error: { message?: string } }).error;
                            if (typeof errObj?.message === "string") {
                                errorDetails = errObj.message;
                            }
                        }
                    } catch {
                        errorDetails = await response.text().catch(() => "");
                    }

                    errorDetails = this.sanitizeErrorDetails(errorDetails);

                    const isRetryable =
                        response.status === 429 ||
                        (response.status >= 500 && response.status < 600);

                    const canRetry =
                        isRetryable &&
                        attempt < this.maxRetries &&
                        !signal?.aborted &&
                        Date.now() - batchStartTime < this.overallTimeoutBudgetMs;

                    if (canRetry) {
                        attempt++;
                        const retryAfter = response.headers.get("retry-after");
                        const delay = this.calculateBackoff(attempt, retryAfter);
                        await this.sleep(delay, signal);
                        continue;
                    }

                    throw new Error(
                        `Gemini embedding request failed with status ${response.status}${errorDetails ? `: ${errorDetails}` : ""}`,
                    );
                }

                let json: unknown;
                try {
                    json = await response.json();
                } catch (parseError) {
                    throw new Error(
                        `Failed to parse Gemini embedding response JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                    );
                }

                if (
                    !json ||
                    typeof json !== "object" ||
                    !("embeddings" in json) ||
                    !Array.isArray((json as { embeddings: unknown }).embeddings)
                ) {
                    throw new Error(
                        "Malformed Gemini embedding response: missing or invalid 'embeddings' array",
                    );
                }

                const embeddings = (json as { embeddings: Array<{ values?: unknown }> }).embeddings;
                if (embeddings.length !== batch.length) {
                    throw new Error(
                        `Gemini embedding response count mismatch: expected ${batch.length}, got ${embeddings.length}`,
                    );
                }

                const batchResults: number[][] = [];
                for (let i = 0; i < embeddings.length; i++) {
                    const item = embeddings[i];
                    if (
                        !item ||
                        typeof item !== "object" ||
                        !("values" in item) ||
                        !Array.isArray(item.values)
                    ) {
                        throw new Error(
                            `Malformed Gemini embedding response item at position ${i}: missing or invalid 'values' array`,
                        );
                    }
                    const values = item.values;
                    if (values.length === 0) {
                        throw new Error(`Embedding vector at index ${i} is empty`);
                    }
                    if (this.dimensions !== undefined && values.length !== this.dimensions) {
                        throw new Error(
                            `Inconsistent embedding dimensions: expected ${this.dimensions}, got ${values.length} at position ${i}`,
                        );
                    }
                    for (let j = 0; j < values.length; j++) {
                        const val = values[j];
                        if (typeof val !== "number" || !Number.isFinite(val)) {
                            throw new Error(
                                `Non-finite value in embedding vector at position ${i}, dimension ${j}`,
                            );
                        }
                    }
                    batchResults.push(values as number[]);
                }

                allResults.push(...batchResults);
                break;
            }
        }

        return allResults;
    };
}
