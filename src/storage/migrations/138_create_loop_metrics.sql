-- Migration 138: Create loop_events and loop_runs metrics tables.
-- loop_events: append-only per-iteration/per-section event log. No FK to loops
-- so rows survive loop deletion (metrics/history retention).
-- loop_runs: one row per loop run (identified by project+loop+started_at).
-- Used by Phase 2 of the loop-metrics feature (rolled out together with
-- loop_events because both belong to the same migration id).

CREATE TABLE IF NOT EXISTS loop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  loop_name TEXT NOT NULL,
  run_started_at INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('coding_done','audit_done','final_audit_done','post_action_done','loop_terminated')),
  outcome TEXT,
  verdict TEXT CHECK (verdict IN ('clean','dirty') OR verdict IS NULL),
  iteration INTEGER,
  section_index INTEGER,
  session_id TEXT,
  role TEXT CHECK (role IN ('code','auditor') OR role IS NULL),
  model TEXT,
  cost REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  findings_total INTEGER,
  findings_bugs INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loop_events_loop ON loop_events(project_id, loop_name, run_started_at, id);
CREATE INDEX IF NOT EXISTS idx_loop_events_created ON loop_events(created_at);

CREATE TABLE IF NOT EXISTS loop_runs (
  project_id TEXT NOT NULL,
  loop_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,
  termination_reason TEXT,
  loop_kind TEXT NOT NULL DEFAULT 'plan',
  execution_model TEXT,
  auditor_model TEXT,
  execution_variant TEXT,
  auditor_variant TEXT,
  iterations INTEGER NOT NULL DEFAULT 0,
  audit_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  total_sections INTEGER NOT NULL DEFAULT 0,
  section_retries INTEGER NOT NULL DEFAULT 0,
  clean_audits INTEGER NOT NULL DEFAULT 0,
  dirty_audits INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, loop_name, started_at)
);

CREATE INDEX IF NOT EXISTS idx_loop_runs_created ON loop_runs(created_at);
