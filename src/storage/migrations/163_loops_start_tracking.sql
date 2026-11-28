-- Migration 163: Loop start tracking.
-- Adds the 'interrupted' status (a loop whose start was never driven to its
-- first prompt), plus request_key, first_prompt_sent_at and start_owner so a
-- start request can be deduplicated and an interrupted start detected. The
-- loops table is rebuilt to widen the status CHECK.
-- Note: PRAGMA foreign_keys=OFF is handled by the migration runner in database.ts

CREATE TABLE loops_new (
  project_id           TEXT NOT NULL,
  loop_name            TEXT NOT NULL,
  status               TEXT NOT NULL CHECK(status IN ('running','paused','completed','cancelled','errored','stalled','interrupted')),
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
  standby_session_id   TEXT,
  execution_agent      TEXT,
  auditor_agent        TEXT,
  post_action_agent    TEXT,
  post_action_model    TEXT,
  post_action_variant  TEXT,
  request_key          TEXT,
  first_prompt_sent_at INTEGER,
  start_owner          TEXT,
  PRIMARY KEY (project_id, loop_name)
);
INSERT INTO loops_new (project_id, loop_name, status, current_session_id, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, phase, execution_model, auditor_model, model_failed, sandbox, sandbox_container, started_at, completed_at, termination_reason, completion_summary, workspace_id, host_session_id, current_section_index, total_sections, execution_variant, auditor_variant, auditor_fallback_index, sandbox_settings, base_commit, standby_session_id, execution_agent, auditor_agent, post_action_agent, post_action_model, post_action_variant)
SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir, worktree_branch, project_dir, max_iterations, iteration, audit_count, error_count, phase, execution_model, auditor_model, model_failed, sandbox, sandbox_container, started_at, completed_at, termination_reason, completion_summary, workspace_id, host_session_id, current_section_index, total_sections, execution_variant, auditor_variant, auditor_fallback_index, sandbox_settings, base_commit, standby_session_id, execution_agent, auditor_agent, post_action_agent, post_action_model, post_action_variant FROM loops;
DROP TABLE loops;
ALTER TABLE loops_new RENAME TO loops;
CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_session ON loops(project_id, current_session_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_loops_completed_at ON loops(status, completed_at) WHERE status != 'running';
CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_project_name ON loops(project_id, loop_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_request_key ON loops(project_id, request_key) WHERE request_key IS NOT NULL;
