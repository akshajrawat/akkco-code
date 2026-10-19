CREATE TABLE IF NOT EXISTS context_summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_sequence INTEGER NOT NULL,
    end_sequence INTEGER NOT NULL,
    summary_json TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, start_sequence, end_sequence)
);

CREATE INDEX IF NOT EXISTS idx_context_summaries_session_range
    ON context_summaries(session_id, start_sequence, end_sequence);
