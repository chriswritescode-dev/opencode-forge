-- Migration 140: Add pagination indexes to loop_runs.
--
-- Dashboard `/api/runs` polls ORDER BY started_at DESC (unfiltered, or
-- filtered by project_id) every refresh window, and `loop_runs` retains
-- rows for `metricsTtlMs`. Migration 138 only indexed `created_at`; the
-- table PK is (project_id, loop_name, started_at), so `started_at` is a
-- trailing column and cannot serve the pagination ORDER BY.
--
-- These indexes were originally added inline to migration 138 WIP, which
-- silently misses any forge.db that already recorded 138 as applied
-- (dev/CI databases opened against the committed branch). Splitting them
-- into their own migration lets the registry apply them to existing DBs.

CREATE INDEX IF NOT EXISTS idx_loop_runs_project_started ON loop_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_loop_runs_page ON loop_runs(started_at DESC, project_id ASC, loop_name ASC);
