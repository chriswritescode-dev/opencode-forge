-- Migration 126: Drop final_audit_attempts column from loops table.
-- The final audit is now bounded only by maxIterations; no separate attempt counter.
DROP TABLE IF EXISTS loops_new;

CREATE TABLE loops_new AS SELECT
  project_id, loop_name, status, current_session_id, worktree, worktree_dir,
  worktree_branch, project_dir, max_iterations, iteration, audit_count,
  error_count, phase, execution_model, auditor_model,
  model_failed, sandbox, sandbox_container, started_at, completed_at,
  termination_reason, completion_summary, workspace_id, host_session_id,
  decomposition_status, decomposition_mode, decomposition_session_id,
  current_section_index, total_sections, final_audit_done
FROM loops;

DROP TABLE loops;
ALTER TABLE loops_new RENAME TO loops;
