# Context Intelligence v1 — Local 7B Manual Validation Guide

This guide describes the manual end-to-end verification procedure for **Context Intelligence v1** using a local 7B coding model (`qwen2.5-coder:7b`) with Ollama.

> [!NOTE]
> This document specifies the reproducible manual testing steps and observable outcomes. Do not claim live-model verification has been completed in automated reports unless a manual run has been performed against a live Ollama instance.

---

## 1. Prerequisites & Environment Setup

### 1.1 Ollama Installation & Model Pull

Install Ollama from [ollama.com](https://ollama.com) and ensure the daemon is running:

```bash
# Check Ollama service status
ollama --version
curl -s http://localhost:11434/api/version

# Pull the Qwen 2.5 Coder 7B Instruct model
ollama pull qwen2.5-coder:7b

# (Optional) Pull embedding model for vector memory retrieval
ollama pull nomic-embed-text
```

### 1.2 Model Context Size Alignment

Ollama defaults to a 2048 or 4096 context window unless explicitly configured. To ensure the backend model runner matches Akkco's profile configuration, create or run with an aligned Modelfile or context size:

```bash
# Option A: Create a custom Ollama model with 8192 context window
cat << 'EOF' > Modelfile.qwen7b
FROM qwen2.5-coder:7b
PARAMETER num_ctx 8192
EOF

ollama create qwen2.5-coder:7b-8k -f Modelfile.qwen7b
```

Alternatively, configure Akkco's environment variables to agree with Ollama's active window:

```bash
# Set Akkco environment variables matching the local model
export AKKCO_BASE_URL="http://localhost:11434/v1"
export AKKCO_MODEL="qwen2.5-coder:7b"
export AKKCO_TOOL_MODE="compatibility"
export AKKCO_CONTEXT_WINDOW_TOKENS="8192"
export AKKCO_MAX_OUTPUT_TOKENS="1024"
export AKKCO_SAFETY_MARGIN_TOKENS="256"
export AKKCO_CHARS_PER_TOKEN="4"

# Optional embedding model configuration
export AKKCO_EMBEDDING_MODEL="nomic-embed-text"
export AKKCO_EMBEDDING_BASE_URL="http://localhost:11434/v1"
```

---

## 2. Launching Akkco Code

Start the Akkco interactive CLI:

```bash
npm start
```

Or run via tsx directly:

```bash
npx tsx apps/cli/src/index.ts
```

Verify startup in the status bar:

- Model: `qwen2.5-coder:7b`
- Tool Mode: `compatibility`
- Provider: `OpenAICompatible`
- Status: `● Idle`

---

## 3. Test Scenarios & Step-by-Step Procedure

### Scenario 1: Basic Tool Execution & Verification

Prompt:

```text
List the files in the repository root directory.
```

**Expected Observable Outcome:**

1. Status changes to `● Running tool`.
2. Indicator appears:
    ```text
    ● list_files
      "."
      ✓ completed · ...ms
    ```
3. Akkco streams the final response listing the root files.
4. Status returns to `● Idle`.

---

### Scenario 2: Active Tool-Result Compaction

To test active tool-result compaction without requiring gigabytes of files, use a small effective budget override or read a large source file.

Launch with a tight context budget for easy reproduction:

```bash
AKKCO_CONTEXT_WINDOW_TOKENS=2048 AKKCO_MAX_OUTPUT_TOKENS=512 npm start
```

Prompt:

```text
Read the contents of package-lock.json and tell me what dependencies are installed.
```

**Expected Observable Outcome:**

1. Tool executes: `● read_file` on `package-lock.json`.
2. Tool output exceeds input capacity headroom (~1400 tokens).
3. Status bar visibly indicates:
    ```text
    ◌ Compacting read_file output...
    ```
4. On completion:
    - Notice displayed: `✓ Context compacted. Continuing...`
    - Canonical transcript in memory and SQLite preserves the full original text.
    - Outbound model preflight passes bounded preflight validation without overflow.
    - The assistant answers the question using the compacted summary.

---

### Scenario 3: History Compaction Across Turns

With an effective budget configured (e.g. `AKKCO_CONTEXT_WINDOW_TOKENS=2048`), trigger multiple dense conversational turns:

1. **Turn 1**:
    ```text
    Explain the architectural relationship between Session, AkkcoRuntime, and BoundedContextCompiler in this repository in 200 words.
    ```
2. **Turn 2**:
    ```text
    Now detail the exact sequence of events during a tool call in compatibility mode in 200 words.
    ```
3. **Turn 3**:
    ```text
    Detail the vector memory serialization and SQLite database schema in 200 words.
    ```
4. **Turn 4**:
    ```text
    What next step should we take to optimize memory retrieval?
    ```

**Expected Observable Outcome:**

1. Accumulated historical context crosses the ~80% threshold.
2. Status bar visibly transitions to:
    ```text
    ◌ Compacting conversation history...
    ```
3. Notice displayed on completion:
    ```text
    ✓ Context compacted. Continuing...
    ```
4. Notice that the newest historical turn is preserved intact for immediate conversational continuity, while older turns are rolled into a structured summary.
5. In SQLite (`context_summaries` table), a new summary checkpoint is stored.
6. The model responds with full awareness of the conversation history.

---

### Scenario 4: Session Navigation & Restoration

#### Step 4.1: Inspect Active Session

Run slash command:

```text
/session
```

**Expected Outcome:**
Displays active session metadata:

```text
Active Session:
  ID: <uuid>
  Transcript: 8 items
  Model: qwen2.5-coder:7b
  Tool Mode: compatibility
```

#### Step 4.2: Exit and Restart

Run slash command:

```text
/exit
```

Restart the CLI:

```bash
npm start
```

#### Step 4.3: List Saved Sessions

Run slash command:

```text
/sessions
```

**Expected Outcome:**
Recent persisted sessions listed newest first with short IDs, update timestamps, and prompt previews:

```text
Persisted Sessions:
  3c8f1e2a · 2026-10-20 08:30:12Z · 8 items · "Explain the architectural relationship between Session..."
  a9b1c2d3 · 2026-10-20 07:15:00Z · 4 items · "List the files in the repository root directory."
  e4f5a6b7 · 2026-10-20 06:45:22Z · 2 items · "hello" (active)
```

#### Step 4.4: Resume Previous Session

Run `/resume` using the short ID from Step 4.3:

```text
/resume 3c8f1e2a
```

**Expected Outcome:**

1. Notice displayed: `Resumed session 3c8f1e2a-... (8 items).`
2. Full conversation presentation history is restored on screen.
3. No model calls or tool replays are executed during restoration.
4. Run `/session` to confirm the active session ID matches the restored session.

#### Step 4.5: Continue Conversation in Resumed Session

Prompt:

```text
What was the first question I asked in this session?
```

**Expected Outcome:**
The model answers accurately ("You asked about the relationship between Session, AkkcoRuntime, and BoundedContextCompiler"), demonstrating unbroken session continuity.

---

## 4. SQLite Database Inspection

Verify SQLite persistence directly using `sqlite3`:

```bash
# Path to default local database
DB_PATH="$HOME/.akkco/akkco.db"

# 1. Inspect sessions table
sqlite3 "$DB_PATH" "SELECT id, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 5;"

# 2. Verify transcript item sequences for active session
sqlite3 "$DB_PATH" "SELECT sequence, type, substr(payload, 1, 80) FROM transcript_items WHERE session_id = 'YOUR_SESSION_ID' ORDER BY sequence ASC;"

# 3. Verify context summary checkpoint
sqlite3 "$DB_PATH" "SELECT start_sequence, end_sequence, estimated_tokens, substr(summary_json, 1, 100) FROM context_summaries WHERE session_id = 'YOUR_SESSION_ID';"

# 4. Verify vector memory indexing (if embedding model was enabled)
sqlite3 "$DB_PATH" "SELECT id, start_sequence, end_sequence, embedding_model, length(embedding) FROM memory_documents WHERE session_id = 'YOUR_SESSION_ID';"
```

---

## 5. Troubleshooting & Edge Cases

| Issue                                                                                     | Cause                                                                       | Resolution                                                                                                                                                    |
| :---------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Very slow token generation (< 5 t/s)**                                                  | GPU offloading disabled or insufficient VRAM. Ollama runs on CPU.           | Check `ollama ps` or run `ollama run qwen2.5-coder:7b` with `--verbose` to verify layer offload. Ensure Ollama utilizes Vulkan/CUDA/ROCm.                     |
| **`ContextBudgetOverflowError`**                                                          | Context window configured too small or model `num_ctx` smaller than prompt. | Increase `AKKCO_CONTEXT_WINDOW_TOKENS` and ensure Ollama `num_ctx` agrees (see Section 1.2).                                                                  |
| **Compaction fallback notice (`⚠ Compaction unavailable; using safe context fallback.`)** | Model failed to emit valid JSON for structured summary within budget.       | Akkco safely falls back to standard turn eviction. If persistent, increase `AKKCO_MAX_OUTPUT_TOKENS` to `1024` so the compactor has enough generation tokens. |
| **Embedding endpoint unreachable (`ECONNREFUSED`)**                                       | Embedding provider offline or port 11434 blocked.                           | Akkco automatically degrades gracefully to keyword/recency memory. Ensure Ollama is running (`ollama serve`).                                                 |
| **Ambiguous session ID error on `/resume`**                                               | The short prefix provided matches multiple saved sessions.                  | Provide a longer prefix or the full UUID listed in `/sessions`.                                                                                               |
