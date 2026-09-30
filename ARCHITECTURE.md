`akkco-code` is one repo, but multiple internal packages:

```
akkco-code/
├── apps/
│   └── cli/        → terminal entrypoint & command loop
└── packages/
    ├── core/       → Akkco runtime, session, transcript & context compiler
    ├── models/     → provider-neutral model contracts & testing utilities
    ├── providers/  → uses model types to connect to provider
    └── tools/      → tool definition, registry & execution contracts
```

1. `apps/cli` : This is the core app that the users see. It contains input/output logic, TUI, cancellation handling (SIGINT / AbortSignal), and interactive commands (`/exit`, `/clear`, `/tools`, `/tool <name> <json>`).

2. `packages/core` : This is the main runtime and session logic (`Session → Runtime`). Organised into `runtime/` (`runtime.ts`, `events.ts`, `tool-host.ts`), `session.ts`, `context/` (`context-compiler.ts`), and `transcript/` (`types.ts`). `Session` exclusively owns the conversation transcript (`TranscriptItem[]`) as its internal source of truth. Before each request, `compileContext(transcript)` compiles the transcript into provider-neutral `ModelItem[]` for `Runtime`. `Runtime` coordinates the automatic model → tool → model agent loop across multiple turns using `RuntimeToolHost` (decoupled from tools/registry internals), yielding `RuntimeEvent` (`RuntimeTextEvent`, `RuntimeToolExecutionEvent`) with loop protection (`maxToolIterations`). `Session` records user turns, assistant pre-tool text, tool executions (`status: "completed" | "failed"`), and final assistant segments, maintaining strict chronological isolation and in-flight locks.

3. `packages/models` : Reorganized under `contracts/` (`items`, `tools`, `request`, `events`, `provider`) and `testing/`. Defines provider-neutral `ModelItem` (`ModelMessage`, `ModelToolCall`, `ModelToolResult`), `ModelTool`, `ModelRequest` (`items`, `tools`, `signal`), and discriminated `ModelEvent` union (`ModelTextEvent`, `ModelToolCallEvent`).

4. `packages/providers` : Implements concrete providers organized in provider-specific folders (e.g. `openai-compatible/`) connecting to model APIs using the common contracts. Under `openai-compatible/`, responsibilities are strictly factored into `request-mapper.ts` (translates provider-neutral `ModelRequest`, `ModelItem` messages/tool calls/results, and `ModelTool` definitions into OpenAI-compatible payload), `stream-parser.ts` (decodes SSE chunks, emits text deltas, incrementally accumulates fragmented `tool_calls` by index/id, safely validates and parses JSON arguments upon completion, and prevents duplicate emissions or incomplete calls on cancellation), and `openai-compatible-provider.ts` (fetch, HTTP status handling, response streaming, cancellation orchestration). Public API boundary is `packages/providers/src/index.ts`.

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

## Development Guardrails

- Formatting: Automated with Prettier matching repository standards (`printWidth: 100`, `tabWidth: 4`, double quotes, semicolons, trailing commas).
- Git Hooks: Managed with Husky and `lint-staged`.
    - `pre-commit`: Runs Prettier against staged source/config files via `lint-staged`.
    - `pre-push`: Runs TypeScript typecheck (`npm run typecheck`) and the full test suite (`npm test`) without mutating files.
