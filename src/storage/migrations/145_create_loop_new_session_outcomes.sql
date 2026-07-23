-- Migration 145: Create loop_new_session_outcomes — the single authoritative
-- correlated launch signal used by the TUI cross-process new-session resolver
-- for BOTH audited goal-loop launches and the disabled/global one-shot fallback.
-- handlePlanNewSession records a row here ONLY after the launch committed
-- (audited: attachLoopToSession returned ok; one-shot: session.create + prompt
-- succeeded), keyed by (project_id, request_nonce). The nonce is minted per
-- launch by the TUI panel and threaded through the execute-plan tool arg /
-- in-process bridge into ForgeExecutionRequestContext.requestId, so concurrent
-- launches in sibling host sessions — even with an identical predicted session
-- title — never collide. All lookups go through the primary key; the resolver
-- gates acceptance on a host match as well.
--
-- No foreign key to loops(): one-shot fallback rows have no loop row, and the
-- table is intentionally decoupled from loop lifecycle so a rolled-back loop
-- cannot orphan its confirmation signal mid-poll.

CREATE TABLE IF NOT EXISTS loop_new_session_outcomes (
  project_id         TEXT NOT NULL,
  request_nonce      TEXT NOT NULL,
  host_session_id    TEXT NOT NULL,
  outcome_session_id TEXT NOT NULL,
  loop_name          TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('audited', 'one-shot')),
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, request_nonce)
);
