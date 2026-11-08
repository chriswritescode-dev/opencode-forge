-- Migration 165: drop the loop-level failure counters.
-- section_runs is the source of truth for error_count, model_failed and
-- auditor_fallback_index now that each run carries its own retry state.

ALTER TABLE loops DROP COLUMN error_count;
ALTER TABLE loops DROP COLUMN model_failed;
ALTER TABLE loops DROP COLUMN auditor_fallback_index;
