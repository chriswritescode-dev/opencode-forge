-- Migration 164: let a loop hold several active section runs.
-- The one-active-run unique index is replaced by key-addressed repository
-- writes, so each run can advance independently. Per-run failure counters move
-- from loops onto section_runs (the backfill below preserves active values),
-- and the lane fields record the worktree a run works in when it differs from
-- the loop's shared worktree.
-- Note: existing loops default to max_parallel_sections = 1 because their
-- sandboxes were created without the per-lane mount.

DROP INDEX IF EXISTS idx_section_runs_one_active;

ALTER TABLE section_runs ADD COLUMN lane_dir TEXT;
ALTER TABLE section_runs ADD COLUMN lane_branch TEXT;
ALTER TABLE section_runs ADD COLUMN lane_base_commit TEXT;
ALTER TABLE section_runs ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE section_runs ADD COLUMN model_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE section_runs ADD COLUMN auditor_fallback_index INTEGER NOT NULL DEFAULT 0;

UPDATE section_runs
SET error_count = COALESCE((
      SELECT loops.error_count FROM loops
      WHERE loops.project_id = section_runs.project_id AND loops.loop_name = section_runs.loop_name
    ), 0),
    model_failed = COALESCE((
      SELECT loops.model_failed FROM loops
      WHERE loops.project_id = section_runs.project_id AND loops.loop_name = section_runs.loop_name
    ), 0),
    auditor_fallback_index = COALESCE((
      SELECT loops.auditor_fallback_index FROM loops
      WHERE loops.project_id = section_runs.project_id AND loops.loop_name = section_runs.loop_name
    ), 0)
WHERE status = 'active';

ALTER TABLE loops ADD COLUMN max_parallel_sections INTEGER NOT NULL DEFAULT 1;
