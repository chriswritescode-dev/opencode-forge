-- Migration 118: Drop audit_session_id column from loops table
-- This collapses the dual-session model into a single live session.
-- On each phase transition, the previous session is deleted and the next one
-- is created bound to the same persistent workspace.
--
-- Note: If any loops are currently in phase=auditing at deploy time, the
-- audit_session_id value is lost. This is acceptable because loops do not
-- persist across forge restarts (boot-time recovery was removed).

ALTER TABLE loops DROP COLUMN audit_session_id;
