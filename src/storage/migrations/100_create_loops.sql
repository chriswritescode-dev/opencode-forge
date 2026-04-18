CREATE TABLE IF NOT EXISTS loops (
  project_id           TEXT NOT NULL,
  loop_name            TEXT NOT NULL,
  status               TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
  current_session_id   TEXT NOT NULL,
  worktree             INTEGER NOT NULL,
  worktree_dir         TEXT NOT NULL,
  worktree_branch      TEXT,
  project_dir          TEXT NOT NULL,
  max_iterations       INTEGER NOT NULL,
  iteration            INTEGER NOT NULL DEFAULT 0,
  audit_count          INTEGER NOT NULL DEFAULT 0,
  error_count          INTEGER NOT NULL DEFAULT 0,
  phase                TEXT NOT NULL CHECK(phase IN ('coding','auditing')),
  audit                INTEGER NOT NULL,
  completion_signal    TEXT,
  execution_model      TEXT,
  auditor_model        TEXT,
  model_failed         INTEGER NOT NULL DEFAULT 0,
  sandbox              INTEGER NOT NULL DEFAULT 0,
  sandbox_container    TEXT,
  started_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  termination_reason   TEXT,
  completion_summary   TEXT,
  PRIMARY KEY (project_id, loop_name)
);
CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_session ON loops(project_id, current_session_id);
CREATE INDEX IF NOT EXISTS idx_loops_completed_at ON loops(status, completed_at) WHERE status != 'running';
