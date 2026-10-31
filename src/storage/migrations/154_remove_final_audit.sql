-- Migration 154: Remove the final audit phase.
-- The last open section audit now completes the loop directly. Running loops
-- caught in a retired final-audit phase are rewritten onto their section
-- equivalents, and the persisted last section is reopened so it becomes a
-- normal section audit/coding state. The loops table is rebuilt without
-- final_audit_done and with the narrowed phase CHECK.
-- Note: PRAGMA foreign_keys=OFF is handled by the migration runner in database.ts

UPDATE loops SET phase = 'auditing' WHERE phase = 'final_auditing';
UPDATE loops SET phase = 'coding' WHERE phase = 'final_audit_fix';

CREATE TABLE loops_new (
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
  phase                TEXT NOT NULL CHECK(phase IN ('coding','auditing','post_action')),
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
  current_section_index INTEGER NOT NULL DEFAULT 0,
  total_sections       INTEGER NOT NULL DEFAULT 0,
  execution_variant    TEXT,
  auditor_variant      TEXT,
  auditor_fallback_index INTEGER NOT NULL DEFAULT 0,
  sandbox_settings     TEXT,
  base_commit          TEXT,
  PRIMARY KEY (project_id, loop_name)
);
INSERT INTO loops_new (project_id, loop_name, status, current_session_id, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, phase, execution_model, auditor_model, model_failed, sandbox, sandbox_container, started_at, completed_at, termination_reason, completion_summary, workspace_id, host_session_id, current_section_index, total_sections, execution_variant, auditor_variant, auditor_fallback_index, sandbox_settings, base_commit)
SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, phase, execution_model, auditor_model, model_failed, sandbox, sandbox_container, started_at, completed_at, termination_reason, completion_summary, workspace_id, host_session_id, current_section_index, total_sections, execution_variant, auditor_variant, auditor_fallback_index, sandbox_settings, base_commit FROM loops;
DROP TABLE loops;
ALTER TABLE loops_new RENAME TO loops;
CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_session ON loops(project_id, current_session_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_loops_completed_at ON loops(status, completed_at) WHERE status != 'running';
CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_project_name ON loops(project_id, loop_name);
