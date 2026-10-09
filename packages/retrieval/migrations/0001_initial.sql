CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_transcript_items_session_seq
    ON transcript_items(session_id, sequence);

CREATE TABLE IF NOT EXISTS memory_documents (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_sequence INTEGER NOT NULL,
    end_sequence INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    embedding_provider TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_dimensions INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_documents_session
    ON memory_documents(session_id);

CREATE INDEX IF NOT EXISTS idx_memory_documents_identity
    ON memory_documents(embedding_provider, embedding_model, embedding_dimensions);
