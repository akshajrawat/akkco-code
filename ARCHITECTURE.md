`akkco-code` is one repo, but multiple internal packages:

```
akkco-code/
├── apps/
│   └── cli/        → terminal bootstrap, controller & presentation
└── packages/
    ├── core/       → Akkco runtime, session, transcript & context compiler
    ├── models/     → provider-neutral model & embedding contracts & testing utilities
    ├── providers/  → model and embedding providers (OpenAI-compatible, compatibility)
    ├── retrieval/  → SQLite persistence infrastructure, vector serialization & memory search
    └── tools/      → tool definition, registry & execution contracts
```

1. `apps/cli` : This is the app that users see. It owns configuration, environment parsing (including model profiles `AKKCO_CONTEXT_WINDOW_TOKENS`, `AKKCO_MAX_OUTPUT_TOKENS`, `AKKCO_SAFETY_MARGIN_TOKENS`, `AKKCO_CHARS_PER_TOKEN`, `AKKCO_TOOL_MODE`), input/output, the Ink/React terminal UI, a plain stream renderer for piped usage, cancellation handling (SIGINT / AbortSignal), and interactive commands (`/exit`, `/clear`, `/tools`, `/tool <name> [json]`). All terminal presentation stays inside this application; internal packages have no dependency on Ink or React. Composition root resolves effective `ModelProfile`, configures bounded providers, and injects storage persistence and the bounded asynchronous context compiler into `Session`.

2. `packages/core` : This is the main runtime and session logic (`Session → Runtime`). Organised into `runtime/` (`runtime.ts`, `events.ts`, `tool-host.ts`, `reliability.ts`), `session.ts`, `context/` (`context-compiler.ts`, `bounded-context-compiler.ts`, `budget.ts`, `token-estimator.ts`, `request-preparer.ts`, `bounded-model-provider.ts`), `memory/` (`memory-document.ts`, `memory-orchestrator.ts`, `memory-retriever.ts`), and `transcript/` (`types.ts`). `Session` exclusively owns the canonical conversation transcript (`TranscriptItem[]`) as its internal source of truth. Before each request, an asynchronous `ContextCompiler` compiles a preliminary bounded set of provider-neutral `ModelItem[]` for `Runtime`. `Runtime` coordinates the automatic model → tool → model agent loop across multiple turns using `RuntimeToolHost`, yielding `RuntimeEvent` with deterministic loop reliability controls. Bounded provider wrappers (`BoundedModelProvider`) and `prepareBoundedModelRequest` enforce authoritative context budgeting at the final preflight stage before any network call.

3. `packages/models` : Reorganized under `contracts/` (`items`, `tools`, `request`, `events`, `provider`, `embedding`, `profile`) and `testing/`. Defines provider-neutral `ModelItem` (`ModelMessage`, `ModelToolCall`, `ModelToolResult`), `ModelTool`, `ModelRequest`, `ModelEvent`, `ModelProvider`, `EmbeddingProvider`, `EmbeddingIdentity`, and `ModelProfile`. Provides profile resolution (`resolveModelProfile`) and validation (`validateModelProfile`) with conservative local presets (Qwen 2.5 Coder, Llama 3) and override hierarchies. In `testing/`, provides `FakeModelProvider` and deterministic offline `DeterministicFakeEmbeddingProvider` for reproducible ranking and similarity testing without randomness.

4. `packages/providers` : Implements concrete providers connecting to model and embedding APIs using the common contracts. Under `openai-compatible/`, provides `OpenAICompatibleProvider` for chat completions (with `max_tokens` mapping and deterministic tool ordering) and `OpenAICompatibleEmbeddingProvider` for `/embeddings`. Under `compatibility/`, implements textual tool-calling compatibility (`text-tool-protocol.ts`, `text-tool-provider.ts`) featuring deterministic tool ordering, compact schemas, and authoritative preflight preparation on initial, tool-loop, and repair requests. Public API boundary is `packages/providers/src/index.ts`.

5. `packages/retrieval` : Manages SQLite-backed local persistence using Node.js built-in `node:sqlite` (`DatabaseSync`). Houses schema versioning (`schema_migrations`, `sessions`, `transcript_items`, `memory_documents`), vector BLOB serialization/deserialization with Float32Array precision, cosine similarity search primitives, and the `ConversationStore` / `SqliteConversationStore` implementation. Public API boundary is `packages/retrieval/src/index.ts`.

6. `packages/tools` : Organised into `core/` (`types`, `executor`, `registry`), `repository/` (`repository-tools`, `filesystem/` tools: `read_file`, `list_files`, `search_text` with path security boundary), and `model/` (`model-tool-adapter`). Concrete tools strictly correlate schema and input via `ToolDefinition<TSchema>`, while dynamic registries erase schemas through `AnyToolDefinition`.

```
Session Transcript (TranscriptItem[])
         │
         ▼
  compileContext()
         │
         ▼
CLI ──> Session ──> Runtime (Agent Loop) ──> ModelProvider
                      │
                      ▼
               RuntimeToolHost
                      │
                 ToolRegistry ──> executeTool ──> Zod Validation ──> tool.execute
                      │
CLI (/tool) ──────────┘

OpenAI ─────┐
Gemini ─────┤
Ollama ─────┼──> ModelProvider
Akkco Model ┘
```

### Tool Execution Modes

#### Native Mode

```
Provider
   ↓
ModelEvent
   ↓
Runtime
```

#### Compatibility Mode (`AKKCO_TOOL_MODE=compatibility`, default)

```
Provider
   ↓
ModelTextEvent
   ↓
Text Tool Compatibility Provider (Strict Protocol & Recovery v1)
   ↓
ModelToolCallEvent
   ↓
Runtime
```

In compatibility mode (the CLI default to match `qwen2.5-coder:7b`), the wrapper intercepts requests before invoking the wrapped provider:

- Injects an ephemeral system instruction defining available tools and the `<akkco_tool_call>` protocol.
- Strips native `request.tools` (`tools: undefined`) to prevent native and textual tool protocols competing.
- Converts previous `ModelToolCall` items into assistant messages with `<akkco_tool_call>` envelopes (merging any preceding assistant pre-tool prose in that turn).
- Converts previous `ModelToolResult` items into user messages with `<akkco_tool_result call_id="..." status="...">` envelopes.
- Emits real-time `ModelTextEvent` chunks for non-protocol prose without buffering delays.
- Buffers and validates `<akkco_tool_call>` envelopes and emits standard `ModelToolCallEvent`s to Runtime.
- Runtime remains completely provider-neutral and unaware whether events originated natively or via compatibility.

##### Compatibility Protocol v1.1 and Recovery

Compatibility Protocol v1.1 relaxes the strict envelope restriction to allow ordinary assistant prose before exactly one valid `<akkco_tool_call>` envelope:

`[optional ordinary prose]`
`<akkco_tool_call>`
`{"name":"ADVERTISED_TOOL","arguments":{...}}`
`</akkco_tool_call>`

The tool envelope MUST remain the final semantic content of the turn.

- **Pre-Tool Prose Supported**: Pre-tool prose is streamed as `ModelTextEvent`s (emitted once) without triggering recovery, followed immediately by exactly one `ModelToolCallEvent`.
- **Post-Envelope Prose Prohibited**: Any prose after `</akkco_tool_call>` remains invalid, as the model must wait for the tool execution result before continuing.
- **Strict Safety Guarantee**: Arbitrary plain JSON or Markdown-fenced JSON never executes. Tool envelopes wrapped in Markdown code fences (e.g. `xml...`) remain invalid and are never parsed as valid calls.
- **Protocol Violation Detection**: Output with tool markers that violates the single terminal envelope contract (such as prose after envelope, multiple envelopes, unclosed envelopes, Markdown-fenced envelopes, unadvertised tools, or malformed JSON) is classified as a protocol violation.
- **Deterministic 1-Turn Repair**: The compatibility provider suppresses tool-protocol fragments from leaking to the user and issues a single corrective repair request containing the malformed assistant response and `COMPATIBILITY_REPAIR_INSTRUCTION`.
- **Repaired Execution**: If the model retries with a strictly valid envelope, `ModelToolCallEvent` is emitted once, and Runtime executes the tool normally.
- **Repair Abandonment**: If the model abandons tool usage and replies with pure conversational prose, the text is accepted as final prose and streamed to the user.
- **Terminal Error on Repeated Violation**: If the second turn also violates the protocol, generation terminates immediately with a clear `Compatibility tool protocol error`. No infinite loops or Runtime reliability retries are triggered.
- **Cancellation**: `AbortSignal` is checked at every transition (before, during, and after repair turns), ensuring cancellation always cleanly throws `AbortError` without being masked as a protocol violation.
- **History Isolation**: Recovery feedback is local to the compatibility wrapper's request turn and never pollutes provider-neutral Runtime history.

Explicit `AKKCO_TOOL_MODE=native` can be selected when using models/providers with reliable native structured tool calling.

## Terminal UI

CLI configuration and environment variable parsing live strictly in the composition and bootstrap layer (`apps/cli/src/config.ts` and `apps/cli/src/index.ts`). `config.ts` validates `AKKCO_TOOL_MODE` (defaulting to `"compatibility"` for `qwen2.5-coder:7b`) and parses `AKKCO_MAX_TOOL_ITERATIONS` as a positive integer (reporting a clear configuration error if invalid). `index.ts` resolves these options and injects pure `reliabilityOptions` into `createCliController`. Neither `createCliController` nor internal packages (`@akkco/core`, `@akkco/models`, `@akkco/providers`, `@akkco/tools`) have any dependency on `process.env`. `AKKCO_BASE_URL`, `AKKCO_MODEL`, and `AKKCO_API_KEY` retain their existing defaults and behavior. The domain packages have no Ink or React dependency.

The controller in `state/cli-controller.ts` coordinates a `Session`, the command subsystem, an active generation's `AbortController`, and CLI presentation state. Slash-command handling is factored out into a dedicated subsystem under `commands/`:

- `commands/command-registry.ts`: defines `CliCommand`, `CommandContext`, and `CommandRegistry` (`createBuiltinCommandRegistry`). It parses slash inputs, extracts the command name and arguments, and dispatches them. Inputs starting with `/` that do not match a known command emit an "Unknown command" notice and are never forwarded to the model; inputs without a leading `/` are passed to `Session.send()`.
- `commands/session-commands.ts`: houses the `/exit` and `/clear` command handlers.
- `commands/tool-commands.ts`: houses `/tools` and manual `/tool <name> [json]` invocation.
- `CommandContext`: exposes a minimal capability boundary (`session`, `tools`, `appendHistory`, `notice`, `exit`, `startToolExecution`, `finishToolExecution`, `isCancelled`) so commands cannot directly mutate arbitrary controller state.

Its tool-host wrapper reports running-tool state before executing the existing registry; unchanged `RuntimeEvent` outcomes complete the presentation. Assistant segments are committed before tool outcomes. React subscribes through `use-cli-controller.ts`, while the plain renderer consumes incremental presentation events. Cancellation and error outcomes belong only to UI state.

### Interactive terminal

When stdin and stdout are TTYs, raw input is supported, and `TERM` is not `dumb`, `app.tsx` mounts the Ink/React application in the normal terminal buffer. `ui/terminal.ts` clears the visible launch command with `\x1b[2J\x1b[H`, enables bracketed paste (`\x1b[?2004h`/`l`), and manages cursor visibility. It never enters the alternate screen or enables alternate scrolling or mouse tracking (`?1000h`/`?1002h`/`?1006h`). Completed output remains in native terminal scrollback for mouse wheel navigation and text selection across turns. No background color is painted.

`ui/layout.ts` computes header dimensions, text wrapping, and prompt/status dimensions. A centered three-row cyan/blue pixel wordmark appears on terminals at least 52 columns wide with 20 usable rows. Narrow or short terminals use a centered text title and reduce metadata or hide the header to preserve the prompt. The current model, tool mode, provider, version, and home-relative directory appear where space permits.

Ink's `<Static>` prints the startup header once per app launch and appends completed messages, tool outcomes, and notices in chronological order. A dynamic spacer below the live response keeps the rounded composer and status bar docked at the bottom after startup, short replies, streaming updates, autocomplete, and history clearing. Live assistant text and tool indicators render directly after committed history; unused space stays beneath them, so replies flow downward from the user message without jumping upward when committed. Autocomplete reports its matching count before draft redraws so popup rows and composer spacing change together. The app tracks how many committed rows remain visible and reduces this spacer as output fills the screen, restoring space when the terminal grows and accounting for rows consumed by Ink's previous-frame erase when it shrinks. History then flows downward, pushing the header and older turns into native scrollback. `components/Conversation.tsx` renders wrapped history entries and the live response. Only the active response/tool indicator, composer, suggestions, and status are redrawn. This dynamic area stays below terminal height so Ink does not clear the terminal and destroy scrollback. Short terminals reduce the suggestion list to available rows, and very small terminals use a borderless composer to keep live output below screen height. The app's resize listener runs before Ink's listener to prevent an oversized stale frame from erasing scrollback. Resize events rewrap the live area; committed output stays in the terminal buffer. PageUp/PageDown and arrow navigation can inspect a long live response, with a `Response ↑` indicator; completed history is navigated with the terminal's native scrolling. `/clear` resets the session and view history without reprinting the startup header, preserving earlier terminal scrollback. Pasted text remains user content, including any copied banner or shell transcript.

Automatic tool events show concise path/query arguments, running/completed/failed/cancelled status, and available duration. Search results show a match count. Automatic file/tool result contents remain inside the agent context rather than being printed. The explicit `/tool <name> [json]` command continues to display its requested result.

`components/PromptInput.tsx` renders a clean, distinguished prompt box with a rounded border (`borderStyle="round"`), colored with the primary theme color (`#00e5ff`) when active and muted gray only after exit. It owns a bounded multiline draft, cursor editing, and slash-command autocomplete integration. Typing, backspace, cursor movement, and paste remain active throughout generation and tool execution. Enter while busy adds the submitted draft to a FIFO controller queue, acknowledged with a queued count in the status bar; drafts submitted multiple times are preserved in order. The controller dispatches the next prompt after the current turn finishes, without overlapping Session calls. Cancellation, exit, and disposal clear pending submissions. Unsubmitted draft text survives turn transitions. When a draft begins with `/`, `ui/command-suggestions.ts` extracts the in-progress command prefix and filters registered commands from the `CommandRegistry` (via `controller.getCommands()`). `components/CommandSuggestions.tsx` renders a bounded suggestion panel immediately above the rounded prompt box with responsive columns (name, description, and usage when width permits). While suggestions are visible, `ArrowUp`/`ArrowDown` cycle through candidates with wrapping, `Tab` completes the command name (adding trailing whitespace for commands requiring arguments), and `Escape` dismisses the palette for the current draft.

`ui/terminal-input.ts` decodes navigation, mouse wheel scrolls, Tab, Escape, and buffers bracketed paste across arbitrary stream chunks. Pasted newlines remain in one draft and never trigger submissions; a separate Enter submits the complete draft. Unbracketed multiline input delivered in one chunk is also treated as a paste. Arrow keys, Home/End, backspace, Delete, and Ctrl+A/E/U are handled in the CLI layer.

Keyboard Ctrl+C and process SIGINT use the controller's interrupt handler. Active generation is aborted and preserves partial text with one cancellation notice; an idle interrupt exits cleanly. The status bar displays Idle, Thinking, Running tool, Cancelled, or Error. Ink's automatic Ctrl+C exit is disabled. `/exit`, SIGTERM/SIGHUP, normal shutdown, and handled UI failures restore raw mode, cursor visibility, bracketed-paste mode, and styling, leaving completed conversation output in the normal terminal buffer. Uncatchable termination such as SIGKILL cannot run restoration.

### Piped usage

If either standard stream is non-TTY, or `TERM=dumb`, `plain-cli.ts` uses buffered readline input and ordinary stream writes. It queues lines while a turn runs and drains the last line at EOF. This preserves incremental assistant output, commands, explicit tool results, and stderr errors without styling, cursor controls, or raw mode, even when `FORCE_COLOR` is set. `/exit` discards subsequent queued lines; EOF drains pending turns without a farewell.

### Pseudo-Terminal (PTY) End-to-End Testing

To test the real interactive TUI end-to-end without mocking React or terminal I/O, `apps/cli/test/pty/` provides a headless terminal test harness:

- **Process Boundary (`node-pty`)**: Spawns the actual Node/tsx process running `apps/cli/src/index.ts` attached to a genuine pseudo-terminal (TTY). This exercises the real TTY detection, `enterTerminal()` normal buffer and bracketed paste setup, raw mode input streaming, Ink rendering pipeline, and OS signal handlers (`SIGINT`/`SIGTERM`).
- **Screen Model (`@xterm/headless`)**: ANSI escape streams emitted by Ink are parsed into an in-memory terminal grid using `@xterm/headless`. `Screen` (`screen.ts`) exposes normalized viewport text with right-trimmed lines and viewport boundaries, eliminating brittle regexes or manual ANSI stripping.
- **Deterministic Test Provider (`test-provider.ts`)**: To keep tests offline, fast, and deterministic without external LLM dependencies, `AKKCO_TEST_PROVIDER=1` routes model calls to `DeterministicTestProvider`. It supports deterministic text streaming, automatic tool loops (`__TEST_TOOL__`), multi-line scrolling content (`__TEST_LONG__`), and long-running cancellable tasks (`__TEST_WAIT__` and the full-screen response `__TEST_LONG_WAIT__`).
- **Testing Pyramid & Split Execution**:
    - `npm test`: Fast unit and component test loop (~7s) covering tool execution, providers, compatibility adapters, layout logic, command parsing, and component rendering.
    - `npm run test:tui`: Dedicated PTY E2E suite (~18s) testing complete interactive workflows (startup, autocomplete, keyboard navigation, Tab completion, `/clear` and `/exit`, streaming responses, tool loops, multiline paste, resizing, scrollback, and process cleanup).
    - `npm run verify`: Full verification pipeline executing formatting check, TypeScript typecheck, unit tests, and the PTY E2E suite.
- **Native Build Requirements**: `node-pty` compiles a native node addon during installation using standard build tools (`make`, `g++`, and Python 3 on Linux/WSL).

## Context Intelligence Foundation & Vector Conversation Memory

### Core Architectural Invariants: Three Distinct Concepts

1. **Session Transcript (`TranscriptItem[]`)**:
   The complete, lossless chronological source of truth. It records every system message, user turn, pre-tool assistant text, tool execution with status/timing, and final assistant message. It is never truncated, bounded, or mutated by retrieved history.
2. **Retrieval Index (`memory_documents` in SQLite)**:
   A derived, searchable representation of completed conversational units. Each document represents a complete user turn (user request + concise deterministic tool activity + final assistant answer). Raw tool result payloads (megabytes of file content or search logs) are never copied into memory documents. Interrupted or failed turns are intentionally omitted from memory indexing.
3. **Compiled Context (`ModelItem[]`)**:
   A temporary, bounded context constructed dynamically for a single model request turn by `ContextCompiler.compile()`. Retrieved memory candidates are framed strictly as lower-trust contextual data in a user message with document provenance (never system instructions, ensuring untrusted history cannot gain system-level authority). Retrieved memory is NEVER appended to or pushed into the canonical Session transcript.

### Package Boundaries & Dependency Inversion

- `@akkco/models`: defines provider-neutral `EmbeddingProvider` (`id`, `model`, `embed(inputs, signal): Promise<number[][]>`) and `EmbeddingIdentity` (`provider`, `model`, `dimensions`). Also provides `DeterministicFakeEmbeddingProvider` in `@akkco/models/testing` for deterministic test fixtures with zero randomness.
- `@akkco/providers`: implements `OpenAICompatibleEmbeddingProvider` connecting to standard `/embeddings` endpoints with batch ordering, non-finite value validation, consistent dimension checks, and `AbortSignal` cancellation.
- `@akkco/retrieval`: persistence layer using Node.js built-in `node:sqlite` (`DatabaseSync`), providing an async domain contract (`ConversationStore`, `SqliteConversationStore`) without leaking raw SQLite row types. Manages versioned SQL-file migrations (`packages/retrieval/migrations/0001_initial.sql`), single connection handle per instance with shared in-flight `initialize()` deduplication, multi-process write locking (`BEGIN IMMEDIATE` with `PRAGMA busy_timeout = 3000;` and exponential jitter backoff), strict foreign key enforcement (`PRAGMA foreign_keys = ON;`), SHA-256 checksum validation, vector BLOB serialization with Float32 overflow checks, corrupt row isolation, and cosine similarity scanning.
- `@akkco/core`: context budgeting (`ContextBudget`), centralized token estimation (`estimateTokens`), turn-level memory document derivation, bounded model request preparation (`prepareBoundedModelRequest`, `ContextBudgetOverflowError`), dynamic memory token reclamation, memory orchestrator (`ConversationMemoryOrchestrator` with bounded timeout, signal cancellation, and drain tracking), memory retriever (`ConversationMemoryRetriever`), and async context compiler (`BoundedContextCompiler`). Does not contain raw SQL or direct HTTP calls.
- `apps/cli`: composition root injecting configuration, default budget (`DEFAULT_CONTEXT_BUDGET`), database path (default `~/.akkco/akkco.db`, override via `AKKCO_DB_PATH`, isolated `:memory:` in test modes), and providers. Enforces fail-fast durable database initialization diagnostics and coordinated shutdown (awaiting active session turn finalization and draining pending memory indexing before closing SQLite).

### Versioned SQLite Migration Infrastructure

Database migrations are managed as ordered `.sql` files in `packages/retrieval/migrations/`:

- **Official Baseline & Forward-Only Policy**: `0001_initial.sql` serves as the mandatory official baseline schema. The runner rejects empty migration directories, missing `0001_initial.sql`, and existing unmanaged conflicting application tables. The runner creates `schema_migrations` (`version`, `filename`, `checksum`, `applied_at`) directly without legacy upgrade or backfill branches. Future migrations execute forward sequentially (`0002_...sql`).
- **Migration Discovery & Order**: Migrations follow `<version>_<name>.sql` (e.g., `0001_initial.sql`). The TypeScript runner (`loadMigrations`) loads files asynchronously, enforces strict sequential versioning starting from 1 with no gaps or duplicates, and computes SHA-256 checksums normalized across line endings.
- **Transactional Application & Async Concurrency**: Migrations run with write locking using `BEGIN IMMEDIATE` and `PRAGMA busy_timeout = 3000;`. Retries on `SQLITE_BUSY` use non-blocking asynchronous backoff with random jitter, avoiding event-loop starvation and lock contention deadlock across competing processes. If any migration fails, its transaction is rolled back completely.
- **Unsupported Legacy Databases & Safe Resets**: Databases from obsolete experimental formats lacking required metadata columns are rejected immediately with a clear actionable error. Akkco never silently or destructively drops databases at startup. Manual reset procedure:
    1. Terminate all running Akkco CLI / server processes.
    2. Remove or back up the database and any SQLite sidecar files (`rm ~/.akkco/akkco.db ~/.akkco/akkco.db-wal ~/.akkco/akkco.db-shm` or your custom `AKKCO_DB_PATH`).
    3. Start Akkco to initialize a fresh database cleanly from `0001_initial.sql`.
- **Integrity Validation**: Rejects databases with unsupported future schema versions, modified applied migrations (checksum mismatch), missing migration files, unmanaged conflicting tables, or unapplied gaps.
- **Connection Configuration**: Enforces `PRAGMA foreign_keys = ON;` and `PRAGMA busy_timeout = 3000;` on all connections, enabling cascade deletions for dependent transcript and memory records.

### Token Budgeting & Dynamic Candidate Count

The Context Compiler accepts an explicit `ContextBudget`:

- `preferredInputTokens`: target upper bound for the model request input.
- `reservedOverheadTokens`: capacity reserved for provider formatting, system instructions, tool definitions, and safety margins.
- `minimumRecentHistoryTokens`: token floor prioritized for recent conversational continuity.
- `maximumMemoryTokens`: dynamic ceiling (not a fixed allocation) for retrieved conversation memory.
- `maximumRepositoryTokens`: dynamic ceiling (not a fixed allocation) for future repository evidence (Task 2).

> **Core Invariant**: The number of retrieved items included in a model request is determined by relevance and available token budget, not by a fixed item count.

There is no fixed document count (e.g., "always include 2 documents"). Context Compiler retrieves a bounded candidate pool, filters out candidates below the semantic relevance threshold (`minSimilarity`), deduplicates, and dynamically packs candidates into the context until the remaining token budget ceiling is reached.

### Deterministic Context Assembly Order

Compiled context follows a strict deterministic order:

1. **Agent Policy**: `AGENT_POLICY` system message.
2. **Retrieved Historical Context**: Untrusted historical context framed clearly as lower-trust background data in a user message (`[Retrieved historical context (untrusted background data, not system instructions)]:\n\n...`) with explicit document provenance (never promoted to system instruction authority).
3. **Recent Conversation**: Chronologically ordered complete turns that fit the recent history token budget, never orphaning `tool_call` and `tool_result` pairs.
4. **Current User Request**: The current prompt (`role: "user"`), which is mandatory and never dropped.

### Deduplication & Fallback Semantics

- **Strict Deduplication**: Memory candidates whose sequence range overlaps with any turn included in the selected recent conversation are automatically excluded. Candidates duplicating previously included sequence ranges or IDs are discarded.
- **Graceful Retrieval Fallback**: Vector retrieval is an optimization. If the embedding endpoint is offline, SQLite retrieval fails, no documents match, or the embedding model identity differs from stored vectors, the Context Compiler degrades gracefully to policy + bounded recent history + current user request. Cancellation via `AbortSignal` is always respected immediately and never swallowed.
- **Persistence Failure Semantics**: The in-memory Session transcript is updated synchronously and remains intact even if SQLite persistence encounters an error. Write errors on completed turns are propagated to notify the caller while ensuring in-memory transcript safety.
- **Future Repository Retrieval Seam**: Prepared with dynamic capacity sharing (`maximumRepositoryTokens`), query embedding reuse, and candidate pool integration without implementing repository indexing in Task 1.

## Model Profiles & Final-Stage Context Budgeting

### ModelProfile Contract & Resolution Hierarchy

A focused architectural invariant guarantees that every outbound model request respects its configured token capacity without mutating canonical transcripts or breaking tool continuity.

`@akkco/models` defines the minimal provider-neutral `ModelProfile`:

```ts
export interface ModelProfile {
    id: string;
    backend?: string;
    contextWindowTokens: number;
    maxOutputTokens: number;
    safetyMarginTokens?: number;
    toolMode: "native" | "compatibility";
    charsPerToken?: number;
}
```

Resolution follows a strict 3-tier precedence hierarchy:

1. **Conservative baseline defaults**:
    - `contextWindowTokens`: 8192
    - `maxOutputTokens`: 1024
    - `safetyMarginTokens`: 256
    - `charsPerToken`: 4
    - `toolMode`: `"compatibility"`
2. **Known model presets**:
    - `qwen2.5-coder` (3B, 7B, 14B, 32B): 8192 window, 1024 max output, 256 safety margin, compatibility tool mode.
    - `llama3` / `llama3.1` / `llama3.2`: 8192 window, 1024 max output, 256 safety margin, compatibility tool mode.
3. **Explicit user/config overrides**:
    - Evaluated at application composition (`apps/cli/src/config.ts` via `resolveCliModelProfile`).
    - `AKKCO_CONTEXT_WINDOW_TOKENS`, `AKKCO_MAX_OUTPUT_TOKENS`, `AKKCO_SAFETY_MARGIN_TOKENS`, `AKKCO_CHARS_PER_TOKEN`, and `AKKCO_TOOL_MODE`.
    - Explicit overrides always win.

### Context Capacity Derivation & Division of Responsibilities

Effective model input capacity is derived by:
$$\text{maxInputTokens} = \text{contextWindowTokens} - \text{maxOutputTokens} - \text{safetyMarginTokens}$$

Example with baseline (8192 / 1024 / 256):
$$\text{maxInputTokens} = 8192 - 1024 - 256 = 6912 \text{ tokens}$$

**Division of Responsibilities:**

- **ModelProfile (`@akkco/models`)**: Defines raw physical limits, reserved generation space (`maxOutputTokens`), safety buffer (`safetyMarginTokens`), and character token estimation ratio (`charsPerToken`).
- **ContextCompiler (`@akkco/core`)**: Determines conversational relevance, applies adaptive proportional context allocation, triggers AI compaction for accumulated history, and embeds persistent SQLite summaries while preserving active turn continuity. Does not redundantly compact active tool results.
- **AI Compactor (`DefaultContextCompactor` in `@akkco/core`)**: Asynchronous, semantic transformation system. Summarizes older historical turns into structured JSON summaries (findings, locations, decisions, failed approaches, unresolved issues, next steps, and omissions), and compacts active oversized tool results before final preflight. Reuses persistent prefix summaries from SQLite (`findLatestContextSummary`) and prunes intermediate superseded checkpoints. Operates strictly without tools (`tools: undefined`), strictly bounds compaction requests to the compactor model's capacity without arbitrary floors, splits single oversized items/lines across chunks, caps operations at $\le 16$ chunks, wraps its internal provider with `ensureBoundedProvider`, and fails closed if any chunk fails.
- **Request Preparer (`prepareBoundedModelRequest` in `@akkco/core`)**: Authoritative, synchronous, deterministic final budget-enforcement boundary after all prompt expansions and transformations. Enforced universally by `ensureBoundedProvider` across both native and compatibility providers and directly inside `AkkcoRuntime`. Performs zero model inference and zero character-based truncation; enforces mandatory items, bounds recent history atomically by turns, and strictly fails closed with `ContextBudgetOverflowError` if any uncompacted or mandatory item exceeds available budget.

### Adaptive Context Allocation

Rather than imposing fixed ceilings (such as historical 1K or 2K caps), Akkco employs a single percentage-based allocator scaling across all context window sizes (from small 2K windows to 128K+):

- **Proportional Soft Targets**:
    - **Recent Conversation**: 25% of discretionary capacity.
    - **Retrieved Memory**: 30% of discretionary capacity (with dynamic expansion if recent conversation is brief).
    - **Repository Evidence**: 30% soft target (released and dynamically reclaimed for conversational turns).
    - **Flexible / Shared Capacity**: 15% discretionary buffer.
- **Explicit Hard Limits (`isHardMemoryLimit`)**:
    - User-specified hard memory caps are explicitly flagged with `isHardMemoryLimit: true` and strictly enforced, preventing heuristic confusion between default soft targets and intentional user limits.
- **Dynamic Token Reclamation**:
    - Capacity unconsumed by memory or unimplemented repository pipelines is dynamically redistributed to historical turns, ensuring deep conversation history is preserved whenever headroom permits.
    - Relevance thresholds, deduplication, and source provenance boundaries are strictly maintained; irrelevant data is never injected merely to fill capacity.
- **Accurate Overhead Accounting**:
    - Actual tool schemas, compatibility instructions, and message framing are accounted for directly in the final preflight rather than relying on arbitrary percentage inflation or double-counting safety margins.

### AI-Assisted Context Compaction

When accumulated conversational turns exceed the compaction threshold (~80% of effective budget) or an active tool result exceeds its allowable token budget (`maxToolOutputTokens` or available capacity), the AI compactor is invoked:

- **Continuity Preservation**: The newest historical turn is always preserved intact alongside the active prompt, guaranteeing immediate conversational context and conversational continuity.
- **Active Tool-Result Compaction (`compactToolResult`)**:
    - Integrated directly into the runtime agent loop (`AkkcoRuntime`), which exclusively owns active tool-result compaction. `BoundedContextCompiler` strictly handles bounded historical context compilation and never redundantly re-compacts active tool results.
    - Preserves full active tool results whenever the complete outgoing request fits safely within model capacity after optional historical-context eviction. AI compaction triggers only when the complete outbound request would exceed available input capacity or an explicitly configured `maxToolOutputTokens` hard limit requires a smaller representation (eliminating arbitrary percentage ceilings).
    - Resolves one effective `ModelProfile` consistently per runtime invocation (`request.profile ?? effectiveProfile`), governing context capacity, reserved output tokens, safety margin, character-token estimation (`charsPerToken`), compaction decisions, and outbound preflight preparation.
    - Compresses large tool payloads into structured summaries highlighting tool name, call ID, file paths, line numbers, errors, exit codes, and structural findings.
    - Enforces strict sizing ($tokens \le target$) with zero 1.5x tolerance; oversized compaction outputs fail closed.
    - Preserves explicit provenance and omission notes (`[Canonical transcript retains full original output (... characters). Details omitted for token budget.]`).
- **Incremental Compaction & Prefix Reuse**:
    - Leverages `findLatestContextSummary` in SQLite to reuse existing prefix summaries (e.g., combining an existing summary for sequences 1–20 with delta turns 21–25 into a consolidated 1–25 summary).
    - Validates prefix boundary continuity: verifies that the prefix summary's start sequence matches the request's start sequence and that its end sequence falls strictly within the requested range, slicing delta turns from the prefix end sequence onward.
    - Frames compaction requests with `PREVIOUS VALIDATED CONTEXT SUMMARY` to guarantee continuous, deduplicated summary roll-ups without repeated LLM calls on exact cache hits.
    - Automatically prunes superseded intermediate checkpoints from SQLite (`context_summaries`) upon saving a broader consolidated summary.
- **Bounded Compaction Invocations**:
    - Compactor model input capacity is strictly respected without arbitrary floors: available chunk content tokens are calculated dynamically as `compactorCapacity - instructionsTokens - reservedForSummary - 8`.
    - Handles single oversized items: single history items or single tool-result lines exceeding chunk capacity are split into bounded chunks.
    - Bounded execution: chunking operations are capped at $\le 16$ chunks to prevent infinite compaction cascades.
    - Fail-closed compaction: if any chunk fails during compaction, the compactor fails closed (never silently dropping failed chunks).
    - Internal provider bounding: wrapped provider is verified via `ensureBoundedProvider` so compactor requests cannot bypass preflight.
    - Compaction model requests strictly enforce `tools: undefined`, ensuring compaction never triggers nested tool loops.
- **Lossless Canonical Transcript**: Canonical transcripts in memory (`Session`) and SQLite (`transcript_items`) remain completely lossless and unaltered. Compaction is exclusively a working context projection.
- **Operational Fault Tolerance**: Compactor errors or provider network failures degrade gracefully to standard turn eviction without corrupting history or crashing the agent session. Abort signals cleanly raise `AbortError`.

### Deterministic Prefix & Token Accounting

Outbound model requests follow a deterministic structural order:

1. **Mandatory static system policy**: `AGENT_POLICY` or configured system instructions.
2. **Compatibility tool instructions**: Deterministically generated instructions when in compatibility mode (`isToolInstruction: true`).
3. **Compacted historical summary**: Untrusted background context message summarizing older turns.
4. **Untrusted retrieved evidence**: Memory / repository documents framed with provenance in user messages.
5. **Recent conversation history**: Prior turns preserved chronologically.
6. **Active turn**: Current user prompt and active assistant tool calls / results.

**Tool Schema Stability & Compaction:**

- Tools advertised to the model are deterministically sorted by name (`tool.name.localeCompare`) without mutating the caller's array.
- Parameter schemas are serialized as compact JSON (`JSON.stringify`) without pretty-printing indentation.
- Tool schemas are accounted for exactly once: in compatibility mode, schemas are embedded into the system prompt; in native mode, tool schemas are counted via `estimateToolsTokens`.
- Character-based token estimation uses `Math.ceil(length / charsPerToken)`, supporting model-specific `charsPerToken` configuration (propagated consistently to compiler, compactor, runtime, and request-preparer).

### Single Authoritative Final Preflight Boundary

Every model invocation passes through final preflight preparation (`prepareBoundedModelRequest`) before hitting the wire:

- **Unavoidable Provider Boundary (`ensureBoundedProvider`)**:
    - Both native and compatibility providers are wrapped with `ensureBoundedProvider`, ensuring requests pass through `prepareBoundedModelRequest`.
    - `AkkcoRuntime` enforces `ensureBoundedProvider` on any provider passed to it, guaranteeing direct consumers cannot bypass preflight even when passing an unwrapped raw or mock provider.
    - `ensureBoundedProvider` inspects delegating wrappers (such as `TextToolCompatibilityProvider`): it unwraps and bounds the inner provider, ensuring transformations execute before budget enforcement.
- **Compatibility Mode Validation**:
    - In compatibility mode, `TextToolCompatibilityProvider` expands XML tool calls/results and protocol-repair instructions (`COMPATIBILITY_REPAIR_INSTRUCTION`). Because its inner provider is wrapped with `prepareBoundedModelRequest`, the fully expanded outbound request (including tool schemas, XML envelopes, and repair instructions) is validated against the model profile before reaching the wire.
- **Native Mode**: Wrapped by `BoundedModelProvider` (`createBoundedModelProvider`), ensuring request projection budgeting executes immediately before the wire mapper.
- **Wire Mapping (`OpenAICompatibleProvider`)**: Maps `profile.maxOutputTokens` directly to the provider payload's `max_tokens`, ensuring inference engines enforce response truncation bounds. Provider-internal metadata (`profile`, `toolResultEnvelope`, etc.) is strictly isolated and never leaked to the wire.
- **Elimination of Competing Systems**: Legacy character-based slicing (`truncateToolResult`, `truncateCompatibilityToolResult`, `truncateAnyToolResult`) and proportional tool fair-share allocation loops (`allocateToolResultBudgets`) are completely eliminated. Request preparation is strictly synchronous, deterministic, and fails closed.

### Fail-Closed & Canonical Invariants

1. **Canonical Transcript Losslessness**:
    - The in-memory Session transcript (`TranscriptItem[]`) and SQLite store (`transcript_items`) are authoritative, complete historical records.
    - AI compaction is a temporary projection applied to working items and outbound requests.
    - Canonical records are never truncated, sliced, mutated, reordered, or deleted to fit a context budget.
2. **Atomic Turn Trimming**:
    - If historical context exceeds `maxInputTokens`, older turns are trimmed atomically as complete pairs (user prompt + assistant response, including all tool calls and tool results).
    - Tool calls and tool results are never orphaned.
3. **Fail-Closed Budget Overflow**:
    - If mandatory context (privileged system policy, tool protocol instructions, active user prompt) or uncompacted tool results exceed available capacity, execution throws `ContextBudgetOverflowError` before calling the model API. Oversized requests are never sent to providers.
4. **Abort Correctness**:
    - Cancellation (`AbortSignal`) retains priority throughout preparation, streaming, compaction, and protocol repair turns, cleanly raising `AbortError` without being converted into budget or compatibility errors.

## Development Guardrails

- Formatting: Automated with Prettier matching repository standards (`printWidth: 100`, `tabWidth: 4`, double quotes, semicolons, trailing commas).
- Git Hooks: Managed with Husky and `lint-staged`.
    - `pre-commit`: Runs Prettier against staged source/config files, including `.tsx`, via `lint-staged`.
    - `pre-push`: Runs TypeScript typecheck (`npm run typecheck`) and the full test suite (`npm test`) without mutating files.
- Verification: `npm run verify` runs formatting checks, TypeScript typechecking (including React JSX), the unit test suite, and the PTY E2E suite. CLI tests cover piped commands and generation, tool event ordering in both modes, EOF handling, persistent bottom placement across short turns and autocomplete, live replies following the user message with unused space beneath them, resize, single-banner rendering through history clearing, native scrollback, active drafting and prompt queueing, tool and cancellation states, deliberate multiline-paste submission, and terminal restoration.
