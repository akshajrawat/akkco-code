# Configuration System v1

AKKCO Code features a production-quality, Codex-style configuration system designed for modular local LLM coding assistance. It replaces scattered environment variables with typed, validated TOML configuration files, secure private credential storage, deterministic multi-tier merging, and repository-level project overrides.

---

## 1. Architectural Overview

The configuration subsystem lives in `apps/cli/src/config/` and enforces strict boundary isolation:

- **Infra-only responsibility**: Configuration files, TOML parsing, and filesystem discovery remain entirely inside the CLI layer. Core packages (`@akkco/core`, `@akkco/models`, `@akkco/tools`, `@akkco/retrieval`) remain decoupled from configuration files.
- **Dependency injection**: Resolved settings flow into existing constructors, profiles, and budget derivations (`resolveCliModelProfile`, `deriveContextBudget`, `createCliController`).
- **Single authoritative state**: A unified `EffectiveConfig` object represents the authoritative runtime configuration after deterministic layer merging.

---

## 2. Configuration Sources and Locations

AKKCO Code discovers configuration from three distinct tiers:

### 1. Global Configuration (Installed CLI)

User-wide defaults and preferences:

| Platform        | Path                                                                                                   |
| :-------------- | :----------------------------------------------------------------------------------------------------- |
| **Linux / WSL** | `${XDG_CONFIG_HOME:-~/.config}/akkco/config.toml`                                                      |
| **macOS**       | `~/Library/Application Support/akkco/config.toml` _(or `${XDG_CONFIG_HOME}/akkco/config.toml` if set)_ |
| **Windows**     | `%APPDATA%\akkco\config.toml`                                                                          |

### 2. Private Credentials File

Private API keys are stored alongside the global configuration in a dedicated environment file:

| Platform        | Path                                                  |
| :-------------- | :---------------------------------------------------- |
| **Linux / WSL** | `${XDG_CONFIG_HOME:-~/.config}/akkco/credentials.env` |
| **macOS**       | `~/Library/Application Support/akkco/credentials.env` |
| **Windows**     | `%APPDATA%\akkco\credentials.env`                     |

#### Key Security Invariants:

- **Restrictive Permissions**: Created with `0600` permissions on POSIX systems (read/write by owner only).
- **Automatic Loading**: Values are loaded automatically without requiring `export KEY=...` in your shell profile.
- **Shell Precedence**: Existing environment variables in your active shell session always take precedence; credentials files never overwrite existing variables.
- **Never in Projects**: Project configurations are untrusted and must never contain credentials.
- **Redaction**: All secret keys (`GEMINI_API_KEY`, `AKKCO_API_KEY`, passwords, tokens) are strictly masked as `[REDACTED]` in configuration outputs, logs, and diagnostics.

### 3. Project Configuration (Repository-Level)

Repositories can customize safe operational settings for team collaboration and development:

- **Path**: `<repository-root>/.akkco/config.toml`
- **Discovery**: Automatically discovers the repository root by searching upward from the current working directory for `.git` or `.akkco/`.
- **Git Ignored**: `.akkco/` is included in the project `.gitignore` so local developer experiments are never accidentally committed.

---

## 3. Configuration Precedence & Merging

Configuration layers are merged deterministically in 5 tiers, from lowest to highest priority:

```text
┌────────────────────────────────────────────────────────┐
│  5. Explicit CLI Overrides (highest precedence)        │
├────────────────────────────────────────────────────────┤
│  4. Project Configuration (<repo>/.akkco/config.toml)  │
├────────────────────────────────────────────────────────┤
│  3. Global Configuration (~/.config/akkco/config.toml) │
├────────────────────────────────────────────────────────┤
│  2. Environment Variables (fallback for omitted items) │
├────────────────────────────────────────────────────────┤
│  1. Built-in Defaults (lowest precedence)              │
└────────────────────────────────────────────────────────┘
```

1. **Built-in Defaults**: Conservative baseline (`qwen2.5-coder:7b`, compatibility tool mode, `http://localhost:11434/v1`).
2. **Environment Variables**: Serves as backward-compatible fallback for settings not specified in configuration files (e.g. `AKKCO_MODEL`, `AKKCO_TOOL_MODE`, `AKKCO_CONTEXT_WINDOW_TOKENS`, `AKKCO_MAX_TOOL_ITERATIONS`).
3. **Global `config.toml`**: Takes precedence over environment variables and built-in defaults across all repositories on the machine.
4. **Project `.akkco/config.toml`**: Overrides global settings and environment variables for allowlisted properties in the repository.
5. **CLI Overrides**: Explicit runtime flags passed during command execution take highest precedence.

---

## 4. Security Model & Project Allowlist

Because project repositories may be cloned from untrusted sources, project configurations are strictly sandboxed. Untrusted projects cannot redirect API traffic, hijack endpoints, or read arbitrary secrets.

### Project Override Allowlist

| Setting                              | Allowed in Project Config? | Notes                                                            |
| :----------------------------------- | :------------------------: | :--------------------------------------------------------------- |
| `model.name`                         |          **Yes**           | Project may recommend a specific local model                     |
| `model.tool_mode`                    |          **Yes**           | `compatibility` or `native`                                      |
| `context.window_tokens`              |          **Yes**           | Repository-specific context budgeting                            |
| `context.max_output_tokens`          |          **Yes**           | Repository-specific generation limits                            |
| `context.safety_margin_tokens`       |          **Yes**           | Repository-specific safety margin                                |
| `context.chars_per_token`            |          **Yes**           | Repository-specific token estimation                             |
| `embedding.model`                    |          **Yes**           | Repository-specific embedding model                              |
| `embedding.dimensions`               |          **Yes**           | Repository-specific vector dimensionality                        |
| `agent.max_tool_iterations`          |          **Yes**           | Maximum agent execution loop count                               |
| `agent.repeated_tool_call_limit`     |          **Yes**           | Threshold before loop terminates on repeated identical calls     |
| `agent.consecutive_tool_error_limit` |          **Yes**           | Threshold before loop terminates on consecutive tool errors      |
| `model.base_url`                     |        **REJECTED**        | **Security sensitive**: Prevents SSRF & data exfiltration        |
| `model.api_key`                      |        **REJECTED**        | **Security sensitive**: Credentials forbidden in repo config     |
| `embedding.provider`                 |        **REJECTED**        | **Security sensitive**: Cannot silently force cloud API calls    |
| `embedding.base_url`                 |        **REJECTED**        | **Security sensitive**: Prevents vector exfiltration             |
| `embedding.api_key_env`              |        **REJECTED**        | **Security sensitive**: Cannot redirect to other secret env vars |
| `embedding.api_key`                  |        **REJECTED**        | **Security sensitive**: Credentials forbidden in repo config     |

Attempting to configure any disallowed setting in `.akkco/config.toml` immediately raises a `ConfigSecurityError` and halts CLI startup before any network or tool execution can occur.

---

## 5. Configuration Format & Schema Reference

Configurations use TOML 1.0 syntax validated by strict schemas:

```toml
[model]
# Model name running on inference server (e.g. Ollama or vLLM)
name = "qwen2.5-coder:7b"

# Provider type: "openai-compatible" (default) or "ollama"
provider = "openai-compatible"

# Inference server URL (global only)
base_url = "http://localhost:11434/v1"

# Tool calling format: "compatibility" (textual markers) or "native" (tool calls)
tool_mode = "compatibility"

[context]
# MUST match the inference server's actual context window (e.g. Ollama num_ctx)
window_tokens = 32768
max_output_tokens = 2048
safety_margin_tokens = 512
chars_per_token = 4

[embedding]
# Cloud-hosted embeddings via Google Gemini or local via OpenAI-compatible
# provider = "gemini"
# model = "gemini-embedding-001"
# dimensions = 768
# api_key_env = "GEMINI_API_KEY"

[agent]
# Maximum iterations for tool calling before prompting user
max_tool_iterations = 25
```

### Context Window & Server Synchronization

> [!IMPORTANT]
> The `context.window_tokens` setting must match your local inference engine's actual context window.
>
> If running Ollama, ensure your Modelfile or startup specifies `PARAMETER num_ctx 32768`. AKKCO Code automatically flows `window_tokens` into the active `ModelProfile` and `deriveContextBudget` to compile context prompts without exceeding server capacity.

---

## 6. Walkthrough: Qwen 2.5 Coder 7B with Gemini Embeddings

Follow this walkthrough to configure AKKCO Code for local inference via Ollama and cloud embeddings via Google Gemini without exporting environment variables manually:

### Step 1: Initialize Global Configuration and Credentials

Run the initialization command to create template files:

```bash
npx tsx apps/cli/src/index.ts config init
```

On Linux/WSL, this creates:

- `~/.config/akkco/config.toml`
- `~/.config/akkco/credentials.env` (with mode `0600`)

### Step 2: Add Your Gemini API Key

Edit `~/.config/akkco/credentials.env`:

```env
GEMINI_API_KEY=AIzaSyYourActualGoogleGeminiKey
```

### Step 3: Configure `config.toml`

Edit `~/.config/akkco/config.toml`:

```toml
[model]
name = "qwen2.5-coder:7b"
provider = "openai-compatible"
base_url = "http://localhost:11434/v1"
tool_mode = "compatibility"

[context]
window_tokens = 32768
max_output_tokens = 2048
safety_margin_tokens = 512

[embedding]
provider = "gemini"
model = "gemini-embedding-001"
dimensions = 768
api_key_env = "GEMINI_API_KEY"

[agent]
max_tool_iterations = 25
```

### Step 4: Verify Effective Configuration

Verify your configuration with secrets redacted:

```bash
npx tsx apps/cli/src/index.ts config show
```

Output:

```text
=== AKKCO Code Configuration ===

Configuration sources:
  Global config:   /home/user/.config/akkco/config.toml [FOUND]
  Credentials:     /home/user/.config/akkco/credentials.env [FOUND]
  Project config:  /home/user/my-repo/.akkco/config.toml [NOT FOUND]

Effective configuration:
[model]
name = "qwen2.5-coder:7b"
provider = "openai-compatible"
base_url = "http://localhost:11434/v1"
tool_mode = "compatibility"

[context]
window_tokens = 32768
max_output_tokens = 2048
safety_margin_tokens = 512

[embedding]
provider = "gemini"
model = "gemini-embedding-001"
dimensions = 768
api_key_env = "GEMINI_API_KEY"

[agent]
max_tool_iterations = 25
```

### Step 5: Start AKKCO Code

Run:

```bash
npm run dev
```

AKKCO Code boots up immediately with Qwen 2.5 Coder 7B, the 32k context window, and Gemini embeddings connected through `credentials.env` without requiring any shell `export` commands.

---

## 7. Configuration CLI Commands

The CLI provides dedicated shell-level configuration commands:

### `akkco config show`

Displays the active configuration merged across all sources with all credentials strictly redacted (`[REDACTED]`). Lists the source of every setting (`[DEFAULT]`, `[GLOBAL]`, `[PROJECT]`, `[ENV]`, or `[CLI]`).

```bash
npx tsx apps/cli/src/index.ts config show
```

### `akkco config validate`

Validates syntax, types, invariants, and security rules across all present configuration and credentials files. Returns exit code 0 if all files are valid, or exit code 1 with actionable diagnostics.

```bash
npx tsx apps/cli/src/index.ts config validate
```

### `akkco config init`

Creates a starter global configuration and private credentials template with POSIX `0600` permissions. Never overwrites existing files.

```bash
# Initialize global config & credentials:
npx tsx apps/cli/src/index.ts config init

# Initialize repository-level project config (.akkco/config.toml):
npx tsx apps/cli/src/index.ts config init --project
```

### Interactive `/config` Slash Command

Within an interactive session, you can inspect the effective configuration at any time by running:

```text
/config
```

or `/config show`. This displays the redacted effective configuration directly in the terminal notice.

---

## 8. Development Workflow in VS Code

When working directly in the AKKCO Code repository:

1. Create a local development config in `.akkco/config.toml`:
    ```bash
    npx tsx apps/cli/src/index.ts config init --project
    ```
2. Edit `.akkco/config.toml` directly in VS Code.
3. The root `.gitignore` excludes `.akkco/` and `.env*`, guaranteeing local changes will never be committed.
4. Run `npm run dev` from anywhere within the repository to automatically use your development configuration.
