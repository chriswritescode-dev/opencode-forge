CREATE TABLE IF NOT EXISTS loop_attempts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         TEXT NOT NULL,
  loop_name          TEXT NOT NULL,
  scope              TEXT NOT NULL,
  attempt_number     INTEGER NOT NULL,
  source_session_id  TEXT NOT NULL,
  completion_key     TEXT NOT NULL,
  auditor_session_id TEXT,
  iteration          INTEGER NOT NULL,
  worktree_dir       TEXT NOT NULL,
  plan_hash          TEXT NOT NULL,
  coder_decisions    TEXT,
  snapshot_commit    TEXT,
  snapshot_ref       TEXT,
  previous_commit    TEXT,
  diff_summary       TEXT,
  fallback_reason    TEXT,
  findings_before    TEXT NOT NULL,
  findings_after     TEXT,
  outcome            TEXT CHECK(outcome IN ('clean','dirty')),
  created_at         INTEGER NOT NULL,
  audited_at         INTEGER,
  UNIQUE (project_id, loop_name, scope, completion_key),
  FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_loop_attempts_loop ON loop_attempts (project_id, loop_name, scope, id);
