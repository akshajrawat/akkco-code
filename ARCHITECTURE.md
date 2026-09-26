`akkco-code` is one repo, but multiple internal packages:

```
akkco-code/
├── apps/
│   └── cli/        → terminal entrypoint & command loop
└── packages/
    ├── core/       → Akkco runtime & session logic
    ├── models/     → model contracts/types
    ├── providers/  → uses model types to connect to provider
    └── tools/      → tool definition, registry & execution contracts
```

1. `apps/cli` : This is the core app that the users see. It contains input/output logic, TUI, cancellation handling (SIGINT / AbortSignal), and interactive commands (`/exit`, `/clear`, `/tools`, `/tool <name> <json>`).

2. `packages/core` : This is the main runtime and session logic (`Session → Runtime`). It manages in-flight execution locks, cancellation propagation, and conversation history, letting the `cli` talk to models.

3. `packages/models` : We will not talk to a single LLM provider but multiple. We don't want to write custom logic for each provider. This package defines common contracts, types, and cancellation (`AbortSignal`).

4. `packages/providers` : Implements concrete providers organized in provider-specific folders (e.g. `openai-compatible/`) connecting to model APIs using the common contracts.

5. `packages/tools` : Organised into `core/` (`types`, `executor`, `registry`) and `repository/` (`repository-tools`, `filesystem/` tools: `read_file`, `list_files`, `search_text` with path security boundary). Concrete tools strictly correlate schema and input via `ToolDefinition<TSchema>`, while dynamic registries erase schemas through `AnyToolDefinition`. Public API boundary is `packages/tools/src/index.ts`.

```
CLI ──> Session ──> Runtime ──> ModelProvider

OpenAI ─────┐
Gemini ─────┤
Ollama ─────┼──> ModelProvider
Akkco Model ┘

CLI (/tool) ──> ToolRegistry ──> executeTool ──> Zod Validation ──> tool.execute
```
