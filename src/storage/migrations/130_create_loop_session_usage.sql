-- Migration 130: Create loop_session_usage table for persisting token usage snapshots.
-- Tracks per-model token usage by role (code, auditor, unknown) for each loop session.
-- Primary key: (project_id, loop_name, session_id, model)
-- Index: (project_id, loop_name) for fast loop-level aggregation.

CREATE TABLE loop_session_usage (
  project_id        TEXT NOT NULL,
  loop_name         TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  role              TEXT NOT NULL CHECK(role IN ('code', 'auditor', 'unknown')),
  model             TEXT NOT NULL,
  cost              REAL NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  message_count     INTEGER NOT NULL DEFAULT 0,
  captured_at       INTEGER NOT NULL,
  PRIMARY KEY (project_id, loop_name, session_id, model),
  FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
);

CREATE INDEX idx_loop_session_usage_project_loop ON loop_session_usage(project_id, loop_name);
