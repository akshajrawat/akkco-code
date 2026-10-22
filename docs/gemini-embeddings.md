# Cloud Embeddings with Google Gemini

Akkco Code supports optional cloud-hosted embeddings via Google's Gemini Embedding API (`gemini-embedding-001`). This eliminates the requirement to run a local embedding model such as `nomic-embed-text` alongside Qwen 2.5 Coder 7B, freeing local GPU/RAM resources for model inference.

---

## Configuration

Cloud embeddings must be **explicitly enabled**; they are never selected silently by default.

### Environment Variables

| Variable                     | Description                                                                                              | Default                                            |
| :--------------------------- | :------------------------------------------------------------------------------------------------------- | :------------------------------------------------- |
| `AKKCO_EMBEDDING_PROVIDER`   | Set to `gemini` to enable Gemini embeddings. Set to `openai-compatible` for local Ollama/Nomic.          | _(none, disabled by default)_                      |
| `AKKCO_EMBEDDING_MODEL`      | Embedding model identifier.                                                                              | `gemini-embedding-001` (when provider is `gemini`) |
| `AKKCO_EMBEDDING_DIMENSIONS` | Output dimensionality (supported via Matryoshka Representation Learning; strictly validated as integer). | `768`                                              |
| `GEMINI_API_KEY`             | Google Gemini API key (or `AKKCO_EMBEDDING_API_KEY`). Required when `AKKCO_EMBEDDING_PROVIDER=gemini`.   | _(none)_                                           |
| `AKKCO_EMBEDDING_BASE_URL`   | Optional base URL override (for testing or enterprise proxies).                                          | `https://generativelanguage.googleapis.com`        |
| `AKKCO_EMBEDDING_DEBUG`      | Set to `true` or `1` to output sanitized diagnostic warnings to stderr on non-fatal embedding failures.  | _(disabled by default)_                            |

---

## Quick Start: Qwen 2.5 Coder + Gemini Embeddings

To run Akkco with local inference via Ollama (Qwen 2.5 Coder 7B) and cloud embeddings via Gemini (without loading `nomic-embed-text`):

```bash
# 1. Start Ollama with Qwen 2.5 Coder (no nomic-embed-text needed)
ollama run qwen2.5-coder:7b

# 2. Configure Akkco for Gemini embeddings
export AKKCO_BASE_URL="http://localhost:11434/v1"
export AKKCO_MODEL="qwen2.5-coder:7b"
export AKKCO_EMBEDDING_PROVIDER="gemini"
export AKKCO_EMBEDDING_MODEL="gemini-embedding-001"
export AKKCO_EMBEDDING_DIMENSIONS="768"
export GEMINI_API_KEY="your-gemini-api-key"

# 3. Launch Akkco
npm run dev
```

---

## Preserving Local / Alternative Embeddings

Local embeddings remain fully supported. To continue using `nomic-embed-text` locally via Ollama:

```bash
export AKKCO_EMBEDDING_PROVIDER="openai-compatible"
export AKKCO_EMBEDDING_MODEL="nomic-embed-text"
export AKKCO_EMBEDDING_BASE_URL="http://localhost:11434/v1"
```

Setting `GEMINI_API_KEY` without `AKKCO_EMBEDDING_PROVIDER=gemini` will **not** trigger cloud embeddings.

---

## Privacy, Security & External Transmission

> [!IMPORTANT]
> **Data Transmission Notice**: When `AKKCO_EMBEDDING_PROVIDER=gemini` is enabled, derived conversation memory documents (user turn queries, concise tool intent summaries, and final assistant replies) and retrieval search queries are transmitted to Google's Gemini API over HTTPS for vector generation.
>
> Raw tool payloads (such as large files read from the repository or search command outputs) are **never** included in memory documents or sent to the embedding provider.

### Credential Protection

- API keys are passed strictly via the `x-goog-api-key` HTTP header; they are never appended to URLs or query parameters.
- API keys are never written to transcripts, SQLite database files, diagnostic logs, or error messages.
- Error responses from Google APIs have API key reflections automatically redacted (`[REDACTED]`).

---

## Model Identity Isolation & SQLite Storage

Akkco's SQLite persistence preserves strict provider identity isolation:

- Documents in `memory_documents` are indexed and queried with composite identity: `(embedding_provider, embedding_model, embedding_dimensions)`.
- Gemini embeddings (`gemini`, `gemini-embedding-001`, `768`) and Nomic embeddings (`openai-compatible`, `nomic-embed-text`, `768`) are stored with unique composite primary keys: `${sessionId}:${startSequence}-${endSequence}:${provider}:${model}`.
- Gemini search queries **never** match or compare against historical Nomic vectors, even if both models use 768 dimensions.
- Historical Nomic vectors are never deleted, overwritten, or modified when switching providers.

---

## Safe Re-Embedding of Historical Memory

Akkco maintains full, lossless conversation transcripts in the `transcript_items` table. Because transcripts are the canonical source of truth, historical sessions previously embedded with Nomic can be safely re-embedded for Gemini without altering existing records:

1. **Side-by-Side Coexistence**: When a turn is indexed with Gemini, it is inserted alongside any existing Nomic document for that turn.
2. **Re-embedding Procedure**:
    - Query historical sessions and transcripts via `store.getTranscriptItems(sessionId)`.
    - Derive memory documents using `deriveMemoryDocumentsFromTranscript(transcript)`.
    - Embed with `GeminiEmbeddingProvider.embed(docs, signal, { taskType: "RETRIEVAL_DOCUMENT" })`.
    - Save via `store.saveMemoryDocuments(...)` with `embeddingProvider: "gemini"`, `embeddingModel: "gemini-embedding-001"`.
    - Historical Nomic rows remain intact in SQLite. If you later switch back to Nomic, Akkco will seamlessly resume querying the Nomic vectors.

---

## Strict Configuration & Validation

Akkco Code enforces fail-fast configuration validation at startup:

- **Missing Credentials**: If `AKKCO_EMBEDDING_PROVIDER=gemini` is specified without a valid `GEMINI_API_KEY` (or `AKKCO_EMBEDDING_API_KEY`), the CLI raises an explicit `EmbeddingConfigurationError` immediately rather than failing silently or crashing during execution.
- **Strict Dimensionality Parsing**: `AKKCO_EMBEDDING_DIMENSIONS` is validated via strict integer parsing (`/^\d+$/`). Non-integer inputs (such as `768abc` or floating-point numbers) or values $\le 0$ throw immediately.
- **Provider Resolution**: The production configuration helper `resolveEmbeddingProvider({ env: process.env })` is independently testable and shared directly across the CLI and test suites.

---

## Timeout Reconciliation & Failure Handling

- **Reconciled Indexer Budget**: The Gemini provider configures a 10-second per-request network timeout with exponential backoff retries. The memory indexer automatically scales its indexing timeout budget to $\ge 15$ seconds (`Math.max(15000, timeoutMs + 5000)`), ensuring that legitimate cloud network requests and retry sequences are not prematurely killed by local timeout budgets.
- **Opt-in Diagnostics**: In the event of a non-fatal indexing or query embedding failure (e.g. quota limits or network outages), users can set `AKKCO_EMBEDDING_DEBUG=true` to receive sanitized diagnostic warnings on `process.stderr`. Diagnostics explicitly redact API keys and omit document/query contents to eliminate credential and data leaks.
- **Graceful Session Continuity**: If Gemini is offline, unreachable, or quota-exhausted:
    - Query retrieval returns `[]` without interrupting or slowing down the prompt loop.
    - Background indexing catches errors gracefully without failing live turns.
    - Session history, transcripts, and context-summary caching continue functioning normally.

---

## Long-Input Handling & Provenance Safety

The `gemini-embedding-001` model has an authoritative input limit of 2,048 tokens:

- **Token-Aware Slicing**: Inputs exceeding 2,048 tokens are bounded by preserving the head (~45%) and tail (~45%) of the text, joined by an explicit omission marker: `[... content truncated for embedding: exceeds 2048 token limit ...]`.
- **Surrogate Pair Integrity**: Character slicing uses Unicode code point awareness (`Array.from(text)`), ensuring that multi-byte code points, surrogate pairs, emojis, and code-heavy Unicode sequences are never split or corrupted.
- **Lossless Document Provenance**: While the embedding vector is computed over the bounded text to satisfy model constraints, the complete, untruncated content is stored in SQLite `memory_documents.content`. Document provenance and full-fidelity context are never discarded.

---

## Literal Session Prefix Matching

When resuming sessions via `/resume <prefix>`:

- The session lookup escapes all SQL `LIKE` wildcards (`%`, `_`, `\`) with `WHERE id LIKE ? || '%' ESCAPE '\\'`.
- Prefix matching is strictly literal and unambiguous, ensuring that session IDs containing underscores (such as `session_2026_01`) cannot unintentionally match unrelated sessions.

---

## Verification

To run focused embedding and reliability verification:

```bash
# Run Gemini provider unit tests
npx tsx --test packages/providers/test/gemini-embedding-provider.test.ts

# Run Gemini retrieval integration tests
npx tsx --test packages/retrieval/test/gemini-embedding-retrieval.test.ts

# Run SQLite store literal prefix tests
npx tsx --test packages/retrieval/test/sqlite-conversation-store.test.ts

# Run CLI configuration tests
npx tsx --test apps/cli/test/gemini-embedding-cli.test.ts

# Run full test suite
npm test
```
