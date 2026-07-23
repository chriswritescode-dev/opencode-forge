-- Migration 147: Create loop_new_session_requests — the staged plan text for a
-- cross-process `plan.execute.newSession` launch. The TUI writes the row —
-- keyed by the same per-launch request_nonce used by outcomes/cancellations —
-- into the shared Forge DB BEFORE dispatching the host-agent instruction, so
-- the host LLM passes only the nonce instead of re-emitting the plan verbatim;
-- the server-side execute-plan tool reads the plan back by nonce.
-- No FK; pruned by TTL sweep.

CREATE TABLE IF NOT EXISTS loop_new_session_requests (
  project_id    TEXT NOT NULL,
  request_nonce TEXT NOT NULL,
  plan_text     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, request_nonce)
);
