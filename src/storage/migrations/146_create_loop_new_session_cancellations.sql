-- Migration 146: Create loop_new_session_cancellations — the authoritative
-- cancellation marker used by the TUI cross-process new-session resolver.
-- When a cross-process launch's resolver times out (the host session stayed
-- busy past the polling deadline), the TUI writes a row here keyed by the
-- launch's request_nonce BEFORE reporting failure to the user. The server-side
-- handlePlanNewSession consults this repo at entry — before creating any
-- session or loop — and refuses to launch when the nonce is already
-- cancelled. This prevents a slow delayed host invocation from silently
-- launching a duplicate loop after the user has retried with a fresh nonce.
-- Decoupled from loop lifecycle (no FK) and idempotent on the primary key so
-- the TUI may re-mark the same nonce safely after a transient write failure.

CREATE TABLE IF NOT EXISTS loop_new_session_cancellations (
  project_id       TEXT NOT NULL,
  request_nonce    TEXT NOT NULL,
  host_session_id  TEXT NOT NULL,
  cancelled_at     INTEGER NOT NULL,
  PRIMARY KEY (project_id, request_nonce)
);
