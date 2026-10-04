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

#### Compatibility Mode (`AKKCO_TOOL_MODE=compatibility`)

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

In compatibility mode, the wrapper intercepts requests before invoking the wrapped provider:

- Injects an ephemeral system instruction defining available tools and the `<akkco_tool_call>` protocol.
- Strips native `request.tools` (`tools: undefined`) to prevent native and textual tool protocols competing.
- Converts previous `ModelToolCall` items into assistant messages with `<akkco_tool_call>` envelopes.
- Converts previous `ModelToolResult` items into user messages with `<akkco_tool_result call_id="..." status="...">` envelopes.
- Emits real-time `ModelTextEvent` chunks for non-protocol prose without buffering delays.
- Buffers and validates exact `<akkco_tool_call>` envelopes and emits standard `ModelToolCallEvent`s to Runtime.
- Runtime remains completely provider-neutral and unaware whether events originated natively or via compatibility.

## Terminal UI

`apps/cli/src/index.ts` validates `AKKCO_TOOL_MODE`, parses `AKKCO_MAX_TOOL_ITERATIONS` as a positive integer (reporting a clear configuration error if invalid), constructs the provider and repository tool registry, reads the CLI version using `node:fs/promises`, and initializes the CLI controller. `AKKCO_BASE_URL`, `AKKCO_MODEL`, and `AKKCO_API_KEY` retain their existing defaults and behavior. The domain packages have no Ink or React dependency.

The controller in `state/cli-controller.ts` coordinates a `Session`, the command subsystem, an active generation's `AbortController`, and CLI presentation state. Slash-command handling is factored out into a dedicated subsystem under `commands/`:

- `commands/command-registry.ts`: defines `CliCommand`, `CommandContext`, and `CommandRegistry` (`createBuiltinCommandRegistry`). It parses slash inputs, extracts the command name and arguments, and dispatches them. Inputs starting with `/` that do not match a known command emit an "Unknown command" notice and are never forwarded to the model; inputs without a leading `/` are passed to `Session.send()`.
- `commands/session-commands.ts`: houses the `/exit` and `/clear` command handlers.
- `commands/tool-commands.ts`: houses `/tools` and manual `/tool <name> [json]` invocation.
- `CommandContext`: exposes a minimal capability boundary (`session`, `tools`, `appendHistory`, `notice`, `exit`, `startToolExecution`, `finishToolExecution`, `isCancelled`) so commands cannot directly mutate arbitrary controller state.

Its tool-host wrapper reports running-tool state before executing the existing registry; unchanged `RuntimeEvent` outcomes complete the presentation. Assistant segments are committed before tool outcomes. React subscribes through `use-cli-controller.ts`, while the plain renderer consumes incremental presentation events. Cancellation and error outcomes belong only to UI state.

### Interactive terminal

When stdin and stdout are TTYs, raw input is supported, and `TERM` is not `dumb`, `app.tsx` mounts the Ink/React application. `ui/terminal.ts` enters the alternate screen, enables bracketed paste, and enables alternate scroll mode (explicitly omitting click/drag mouse tracking such as SGR and X10 so native text selection works). The application uses the terminal width and height, reserving one bottom row for Ink's trailing newline to avoid terminal scrolling. No background color is painted.

`ui/layout.ts` computes a fixed header, expanding conversation viewport, and fixed prompt/status footer. A centered three-row cyan/blue pixel wordmark appears on terminals at least 52 columns wide with 20 usable rows. Narrow or short terminals use a centered text title and reduce metadata or hide the header to preserve the prompt. The current model, tool mode, provider, version, and home-relative directory appear where space permits. Resize events recompute layout and text wrapping.

`components/Conversation.tsx` renders only the visible wrapped conversation lines, replacing the former Ink `Static` scrollback approach. The viewport shows user and assistant labels, streaming text, tool executions, errors, cancellation, and notices. New output follows the latest content by default. PageUp/PageDown, Shift+PageUp/Down, Up/Down arrow navigation (at empty prompt or prompt boundaries), and mouse wheel trackpad scrolling navigate retained in-memory history; while scrolled up, incoming lines preserve the reader's position. Submitting a new prompt or returning to the bottom resumes following new output. `/clear` resets the session, UI history, and scroll position.

Automatic tool events show concise path/query arguments, running/completed/failed/cancelled status, and available duration. Search results show a match count. Automatic file/tool result contents remain inside the agent context rather than being printed. The explicit `/tool <name> [json]` command continues to display its requested result.

`components/PromptInput.tsx` owns a bounded multiline draft, cursor editing, and slash-command autocomplete integration. When a draft begins with `/`, `ui/command-suggestions.ts` extracts the in-progress command prefix and filters registered commands from the `CommandRegistry` (via `controller.getCommands()`). `components/CommandSuggestions.tsx` renders a bounded suggestion panel immediately above the prompt with responsive columns (name, description, and usage when width permits). While suggestions are visible, `ArrowUp`/`ArrowDown` cycle through candidates with wrapping, `Tab` completes the command name (adding trailing whitespace for commands requiring arguments), and `Escape` dismisses the palette for the current draft. The conversation viewport height dynamically shrinks by the suggestion panel height, preserving the terminal's overall row layout.

`ui/terminal-input.ts` decodes navigation, mouse wheel scrolls, Tab, Escape, and buffers bracketed paste across arbitrary stream chunks. Pasted newlines remain in one draft and never trigger submissions; a separate Enter submits the complete draft. Unbracketed multiline input delivered in one chunk is also treated as a paste. Arrow keys, Home/End, backspace, Delete, Ctrl+A/E/U, PageUp/PageDown, and mouse wheel events are handled in the CLI layer. The prompt remains fixed while output streams.

Keyboard Ctrl+C and process SIGINT use the controller's interrupt handler. Active generation is aborted and preserves partial text with one cancellation notice; an idle interrupt exits cleanly. The status bar displays Idle, Thinking, Running tool, Cancelled, or Error. Ink's automatic Ctrl+C exit is disabled. `/exit`, SIGTERM/SIGHUP, normal shutdown, and handled UI failures restore raw mode, cursor visibility, bracketed-paste mode, and the previous shell screen. Uncatchable termination such as SIGKILL cannot run restoration.

### Piped usage

If either standard stream is non-TTY, or `TERM=dumb`, `plain-cli.ts` uses buffered readline input and ordinary stream writes. It queues lines while a turn runs and drains the last line at EOF. This preserves incremental assistant output, commands, explicit tool results, and stderr errors without styling, cursor controls, or raw mode, even when `FORCE_COLOR` is set. `/exit` discards subsequent queued lines; EOF drains pending turns without a farewell.

### Pseudo-Terminal (PTY) End-to-End Testing

To test the real interactive TUI end-to-end without mocking React or terminal I/O, `apps/cli/test/pty/` provides a headless terminal test harness:

- **Process Boundary (`node-pty`)**: Spawns the actual Node/tsx process running `apps/cli/src/index.ts` attached to a genuine pseudo-terminal (TTY). This exercises the real TTY detection, `enterTerminal()` alternate screen setup, raw mode input streaming, Ink rendering pipeline, and OS signal handlers (`SIGINT`/`SIGTERM`).
- **Screen Model (`@xterm/headless`)**: ANSI escape streams emitted by Ink are parsed into an in-memory terminal grid using `@xterm/headless`. `Screen` (`screen.ts`) exposes normalized viewport text with right-trimmed lines and viewport boundaries, eliminating brittle regexes or manual ANSI stripping.
- **Deterministic Test Provider (`test-provider.ts`)**: To keep tests offline, fast, and deterministic without external LLM dependencies, `AKKCO_TEST_PROVIDER=1` routes model calls to `DeterministicTestProvider`. It supports deterministic text streaming, automatic tool loops (`__TEST_TOOL__`), multi-line scrolling content (`__TEST_LONG__`), and long-running cancellable tasks (`__TEST_WAIT__`).
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
- Verification: `npm run verify` runs formatting checks, TypeScript typechecking (including React JSX), the unit test suite, and the PTY E2E suite. CLI tests cover piped commands and generation, tool event ordering in both modes, EOF handling, full-screen layout calculations, resize and history scrolling, tool and cancellation states, deliberate multiline-paste submission, and terminal restoration.
