`akkco-code` is one repo, but multiple internal packages:

```
akkco-code/
├── apps/
│   └── cli/        → terminal bootstrap, controller & presentation
└── packages/
    ├── core/       → Akkco runtime, session, transcript & context compiler
    ├── models/     → provider-neutral model contracts & testing utilities
    ├── providers/  → uses model types to connect to provider
    └── tools/      → tool definition, registry & execution contracts
```

1. `apps/cli` : This is the app that users see. It owns configuration, input/output, the Ink/React terminal UI, a plain stream renderer for piped usage, cancellation handling (SIGINT / AbortSignal), and interactive commands (`/exit`, `/clear`, `/tools`, `/tool <name> [json]`). All terminal presentation stays inside this application; internal packages have no dependency on Ink or React.

2. `packages/core` : This is the main runtime and session logic (`Session → Runtime`). Organised into `runtime/` (`runtime.ts`, `events.ts`, `tool-host.ts`, `reliability.ts`), `session.ts`, `context/` (`context-compiler.ts`), and `transcript/` (`types.ts`). `Session` exclusively owns the conversation transcript (`TranscriptItem[]`) as its internal source of truth. Before each request, `compileContext(transcript)` compiles the transcript into provider-neutral `ModelItem[]` for `Runtime`. `Runtime` coordinates the automatic model → tool → model agent loop across multiple turns using `RuntimeToolHost` (decoupled from tools/registry internals), yielding `RuntimeEvent` (`RuntimeTextEvent`, `RuntimeToolExecutionEvent`) with deterministic loop reliability controls via `RuntimeReliabilityOptions` (`maxToolIterations` defaulting to 25, `repeatedToolCallLimit` defaulting to 3, and `consecutiveToolErrorLimit` defaulting to 4). If repeated identical tool calls are detected using canonicalized argument signatures, reaching the repetition threshold emits a synthetic warning `ModelToolResult` without re-executing the duplicate; if repeated again without strategy change, the loop terminates with `AgentLoopError(reason="repeated_tool_call")`. If tool executions repeatedly fail, reaching the consecutive error threshold terminates the loop with `AgentLoopError(reason="consecutive_tool_errors")` (resetting the error counter on any success). `AbortSignal` cancellation takes precedence over reliability limits. `Session` records user turns, assistant pre-tool text, tool executions (`status: "completed" | "failed"`), and final assistant segments, maintaining strict chronological isolation and in-flight locks.

3. `packages/models` : Reorganized under `contracts/` (`items`, `tools`, `request`, `events`, `provider`) and `testing/`. Defines provider-neutral `ModelItem` (`ModelMessage`, `ModelToolCall`, `ModelToolResult`), `ModelTool`, `ModelRequest` (`items`, `tools`, `signal`), and discriminated `ModelEvent` union (`ModelTextEvent`, `ModelToolCallEvent`).

4. `packages/providers` : Implements concrete providers organized in provider-specific folders (e.g. `openai-compatible/`) connecting to model APIs using the common contracts. Under `openai-compatible/`, responsibilities are strictly factored into `request-mapper.ts` (translates provider-neutral `ModelRequest`, `ModelItem` messages/tool calls/results, and `ModelTool` definitions into OpenAI-compatible payload), `stream-parser.ts` (decodes SSE chunks, emits text deltas, incrementally accumulates fragmented `tool_calls` by index/id, safely validates and parses JSON arguments upon completion, and prevents duplicate emissions or incomplete calls on cancellation), and `openai-compatible-provider.ts` (fetch, HTTP status handling, response streaming, cancellation orchestration). Under `compatibility/`, implements textual tool-calling compatibility (`text-tool-protocol.ts`, `text-tool-provider.ts`) for models/providers that understand tools conceptually but do not emit native structured tool calls (e.g. Ollama + `qwen2.5-coder:3b`). It converts historical `ModelToolCall` and `ModelToolResult` items into textual protocol messages (`<akkco_tool_call>`, `<akkco_tool_result>`) and injects ephemeral tool instructions into the request sent to the wrapped provider with `tools: undefined`. It parses incoming model text envelopes into provider-neutral `ModelToolCallEvent`s while streaming normal text without buffering delays. Public API boundary is `packages/providers/src/index.ts`.

5. `packages/tools` : Organised into `core/` (`types`, `executor`, `registry`), `repository/` (`repository-tools`, `filesystem/` tools: `read_file`, `list_files`, `search_text` with path security boundary), and `model/` (`model-tool-adapter`). Concrete tools strictly correlate schema and input via `ToolDefinition<TSchema>`, while dynamic registries erase schemas through `AnyToolDefinition`. The model tool adapter bridges executable `ToolDefinition` to provider-neutral `ModelTool` descriptions (`toModelTool`, `toModelTools`), converting Zod schemas to clean JSON Schemas while stripping execution details and schema metadata. Depends on `@akkco/models` for the contract without circular dependencies. Public API boundary is `packages/tools/src/index.ts`.

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
Text Tool Compatibility Provider
   ↓
ModelToolCallEvent
   ↓
Runtime
```

In compatibility mode (the CLI default to match `qwen2.5-coder:3b`), the wrapper intercepts requests before invoking the wrapped provider:

- Injects an ephemeral system instruction defining available tools and the `<akkco_tool_call>` protocol.
- Strips native `request.tools` (`tools: undefined`) to prevent native and textual tool protocols competing.
- Converts previous `ModelToolCall` items into assistant messages with `<akkco_tool_call>` envelopes.
- Converts previous `ModelToolResult` items into user messages with `<akkco_tool_result call_id="..." status="...">` envelopes.
- Emits real-time `ModelTextEvent` chunks for non-protocol prose without buffering delays.
- Buffers and validates exact `<akkco_tool_call>` envelopes and emits standard `ModelToolCallEvent`s to Runtime.
- Runtime remains completely provider-neutral and unaware whether events originated natively or via compatibility.

Explicit `AKKCO_TOOL_MODE=native` can be selected when using models/providers with reliable native structured tool calling.

## Terminal UI

CLI configuration and environment variable parsing live strictly in the composition and bootstrap layer (`apps/cli/src/config.ts` and `apps/cli/src/index.ts`). `config.ts` validates `AKKCO_TOOL_MODE` (defaulting to `"compatibility"` for `qwen2.5-coder:3b`) and parses `AKKCO_MAX_TOOL_ITERATIONS` as a positive integer (reporting a clear configuration error if invalid). `index.ts` resolves these options and injects pure `reliabilityOptions` into `createCliController`. Neither `createCliController` nor internal packages (`@akkco/core`, `@akkco/models`, `@akkco/providers`, `@akkco/tools`) have any dependency on `process.env`. `AKKCO_BASE_URL`, `AKKCO_MODEL`, and `AKKCO_API_KEY` retain their existing defaults and behavior. The domain packages have no Ink or React dependency.

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

## Development Guardrails

- Formatting: Automated with Prettier matching repository standards (`printWidth: 100`, `tabWidth: 4`, double quotes, semicolons, trailing commas).
- Git Hooks: Managed with Husky and `lint-staged`.
    - `pre-commit`: Runs Prettier against staged source/config files, including `.tsx`, via `lint-staged`.
    - `pre-push`: Runs TypeScript typecheck (`npm run typecheck`) and the full test suite (`npm test`) without mutating files.
- Verification: `npm run verify` runs formatting checks, TypeScript typechecking (including React JSX), the unit test suite, and the PTY E2E suite. CLI tests cover piped commands and generation, tool event ordering in both modes, EOF handling, persistent bottom placement across short turns and autocomplete, live replies following the user message with unused space beneath them, resize, single-banner rendering through history clearing, native scrollback, active drafting and prompt queueing, tool and cancellation states, deliberate multiline-paste submission, and terminal restoration.
