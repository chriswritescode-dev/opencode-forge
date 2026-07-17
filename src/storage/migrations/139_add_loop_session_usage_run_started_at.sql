-- Migration 139: Add run_started_at column to loop_session_usage.
-- Run identity is the loop's started_at ms-epoch at capture time. Persisting it
-- on each usage row lets getAggregateForRun filter by exact equality instead of
-- the ambiguous captured_at >= runStartedAt lower bound, which could fold a
-- prior run's rows into a restarted run when both share the same millisecond.
-- Index mirrors the (project_id, loop_name, run_started_at) pattern used by
-- loop_events so run-scoped aggregation stays index-backed.

ALTER TABLE loop_session_usage ADD COLUMN run_started_at INTEGER NOT NULL DEFAULT 0;

-- Backfill legacy rows so an upgrade mid-active-loop preserves their
-- contribution to the eventual loop_runs summary. Pre-migration rows carried
-- no run identity, so the safest attribution is the loop's CURRENT run
-- (loops.started_at), which is the run any in-flight capture belongs to.
-- Rows whose loop has no loops row (orphaned / swept) keep run_started_at = 0
-- and remain invisible to run aggregates — correct, since no run row can ever
-- reference them.
UPDATE loop_session_usage
SET run_started_at = (
  SELECT loops.started_at FROM loops
  WHERE loops.project_id = loop_session_usage.project_id
    AND loops.loop_name = loop_session_usage.loop_name
)
WHERE run_started_at = 0
  AND EXISTS (
    SELECT 1 FROM loops
    WHERE loops.project_id = loop_session_usage.project_id
      AND loops.loop_name = loop_session_usage.loop_name
  );

CREATE INDEX IF NOT EXISTS idx_loop_session_usage_run
  ON loop_session_usage(project_id, loop_name, run_started_at);
