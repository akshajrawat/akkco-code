# Akkco Code

A modular, terminal-based agentic AI coding assistant designed for pair programming, repository inspection, and automated tool execution.

For detailed system design, contracts, protocol recovery, and architectural specifications, see [ARCHITECTURE.md](file:///home/aksha/akkco-code/ARCHITECTURE.md).

---

## Workspace Structure

- **`apps/cli`**: Interactive Ink/React terminal application, command parser, PTY test harness, and plain piped renderer.
- **`packages/core`**: Core runtime, agent loop orchestration, session state, chronological transcript, and loop reliability guards (cycle detection, error limits).
- **`packages/models`**: Provider-neutral contracts, item types, events, tool representations, and test fakes.
- **`packages/providers`**: Concrete model integrations, including OpenAI-compatible endpoints and strict textual tool compatibility protocols for local/small models.
- **`packages/tools`**: Repository tools (`read_file`, `list_files`, `search_text`), path containment enforcement, Zod schemas, and model adapters.

---

## Getting Started

### Prerequisites

- Node.js (v20+ recommended)
- npm

### Installation

```bash
npm install
```

### Running the CLI

Start the interactive terminal UI:

```bash
npm run dev
```

### Configuration

Environment variables can be configured to customize runtime behavior:

- `AKKCO_BASE_URL`: Base URL for the model provider API (default: `http://localhost:11434/v1`).
- `AKKCO_MODEL`: Model name to target (default: `qwen2.5-coder:7b`).
- `AKKCO_API_KEY`: API key if required by the target provider.
- `AKKCO_TOOL_MODE`: Tool execution mode (`compatibility` [default] or `native`).
- `AKKCO_MAX_TOOL_ITERATIONS`: Maximum tool loop iterations per turn (default: `25`).

---

## Development & Testing

```bash
# Typecheck TypeScript code across all packages
npm run typecheck

# Run unit and component test suites
npm test

# Run interactive PTY end-to-end tests
npm run test:tui

# Check code formatting
npm run format:check

# Run complete verification pipeline
npm run verify
```

---

## Architecture & Specifications

For comprehensive details on:

- Multi-turn runtime loops & session transcripts
- Reliability v1.1 cycle detection (`detectRepeatedToolCycle`)
- Strict textual tool compatibility protocol & recovery
- Repository relative path discipline & containment protections
- Terminal UI layout, scrolling, and PTY testing harness

Please refer to [`ARCHITECTURE.md`](file:///home/aksha/akkco-code/ARCHITECTURE.md).
