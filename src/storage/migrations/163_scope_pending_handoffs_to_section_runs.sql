-- Migration 163: Scope pending loop handoffs to the section run that recorded them.
-- loop_handoffs gains section_run_key ('section:<id>', 'plan' or 'post_action') so
-- the one-pending-handoff rule applies per section run instead of per loop. Existing
-- pending rows are backfilled from the loop's active section_runs row; applied and
-- discarded rows keep an empty key, so resolved history is unchanged.

ALTER TABLE loop_handoffs ADD COLUMN section_run_key TEXT NOT NULL DEFAULT '';

UPDATE loop_handoffs
SET section_run_key = COALESCE((
  SELECT CASE WHEN r.kind = 'section' THEN 'section:' || r.section_id ELSE r.kind END
  FROM section_runs r
  WHERE r.project_id = loop_handoffs.project_id
    AND r.loop_name = loop_handoffs.loop_name
    AND r.status = 'active'
), '')
WHERE status = 'pending' AND section_run_key = '';

DROP INDEX IF EXISTS idx_loop_handoffs_pending;
CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_handoffs_pending ON loop_handoffs (project_id, loop_name, section_run_key) WHERE status = 'pending';
