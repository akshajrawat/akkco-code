`akkco-code` is one repo, but multiple internal packages:

```
akkco-code/
├── apps/
│   └── cli/        → terminal entrypoint
└── packages/
    ├── core/       → Akkco runtime logic
    └── models/     → model contracts/types
    └── providers/  → uses model types to connect to provider
```

1. `apps/cli` : This is the core app that the users see. It will contain input/output logic, TUI, etc.

2. `packages/core` : This is the main runtime logic that will let the `cli` talk to other things like `models` or `tools` etc

3. `packages/models` : We will not talk to a single LLM provider but multiple. We don't want to write custom logic for each of the provider. This package will work as a common communication hub for them.

```
OpenAI ─────┐
Gemini ─────┤
Ollama ─────┼──> ModelProvider ──> Akkco Core
Akkco Model ┘
```
