`akkco-code` is one repo, but multiple internal packages:

```
akkco-code/
├── apps/
│   └── cli/        → terminal entrypoint
└── packages/
    ├── core/       → Akkco runtime & session logic
    └── models/     → model contracts/types
    └── providers/  → uses model types to connect to provider
```

1. `apps/cli` : This is the core app that the users see. It will contain input/output logic, TUI, cancellation handling, etc.

2. `packages/core` : This is the main runtime and session logic (`Session → Runtime`). It manages in-flight execution locks, cancellation propagation, and conversation history, letting the `cli` talk to models or tools.

3. `packages/models` : We will not talk to a single LLM provider but multiple. We don't want to write custom logic for each of the provider. This package defines common contracts, types, and cancellation (`AbortSignal`).

4. `packages/providers` : Implements concrete providers organized in provider-specific folders (e.g. `openai-compatible/`) connecting to model APIs using the common contracts.

```
CLI ──> Session ──> Runtime ──> ModelProvider

OpenAI ─────┐
Gemini ─────┤
Ollama ─────┼──> ModelProvider
Akkco Model ┘
```
