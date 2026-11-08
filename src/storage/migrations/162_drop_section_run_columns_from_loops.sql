-- Migration 162: Drop the per-section columns from loops.
-- section_runs (migration 161) is the single source of truth for the active
-- run's session, phase, section index and standby session. The loops row keeps
-- only loop-level state, so current_session_id, phase, current_section_index and
-- standby_session_id are removed along with the insert trigger that copied them
-- into section_runs; new runs are created by the repository.
-- Note: PRAGMA foreign_keys=OFF is handled by the migration runner in database.ts

DROP TRIGGER IF EXISTS trg_loops_insert_section_run;

CREATE TABLE loops_new (
  project_id           TEXT NOT NULL,
  loop_name            TEXT NOT NULL,
  status               TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
  worktree             INTEGER NOT NULL,
  worktree_dir         TEXT NOT NULL,
  worktree_branch      TEXT,
  project_dir          TEXT NOT NULL,
  max_iterations       INTEGER NOT NULL,
  iteration            INTEGER NOT NULL DEFAULT 0,
  audit_count          INTEGER NOT NULL DEFAULT 0,
  error_count          INTEGER NOT NULL DEFAULT 0,
  execution_model      TEXT,
  auditor_model        TEXT,
  model_failed         INTEGER NOT NULL DEFAULT 0,
  sandbox              INTEGER NOT NULL DEFAULT 0,
  sandbox_container    TEXT,
  started_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  termination_reason   TEXT,
  completion_summary   TEXT,
  workspace_id         TEXT,
  host_session_id      TEXT,
  total_sections       INTEGER NOT NULL DEFAULT 0,
  execution_variant    TEXT,
  auditor_variant      TEXT,
  auditor_fallback_index INTEGER NOT NULL DEFAULT 0,
  sandbox_settings     TEXT,
  base_commit          TEXT,
  PRIMARY KEY (project_id, loop_name)
);
INSERT INTO loops_new (project_id, loop_name, status, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, execution_model, auditor_model, model_failed, sandbox, sandbox_container, started_at, completed_at, termination_reason, completion_summary, workspace_id, host_session_id, total_sections, execution_variant, auditor_variant, auditor_fallback_index, sandbox_settings, base_commit)
SELECT project_id, loop_name, status, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, execution_model, auditor_model, model_failed, sandbox, sandbox_container, started_at, completed_at, termination_reason, completion_summary, workspace_id, host_session_id, total_sections, execution_variant, auditor_variant, auditor_fallback_index, sandbox_settings, base_commit FROM loops;
DROP TABLE loops;
ALTER TABLE loops_new RENAME TO loops;
CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(project_id, status);
CREATE INDEX IF NOT EXISTS idx_loops_completed_at ON loops(status, completed_at) WHERE status != 'running';
CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_project_name ON loops(project_id, loop_name);
