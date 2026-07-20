-- Migration 139: Create loop_transitions table for persisted transition log.
-- Captures every loop phase change and termination as an append-only row.
-- Foreign keys to loops(project_id, loop_name) with ON DELETE CASCADE so the
-- transition history is pruned automatically when a loop row is deleted.

CREATE TABLE IF NOT EXISTS loop_transitions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  loop_name       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  transition_kind TEXT NOT NULL,
  from_phase      TEXT NOT NULL,
  to_phase        TEXT,
  status          TEXT,
  reason          TEXT,
  iteration       INTEGER NOT NULL DEFAULT 0,
  section_index   INTEGER,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_loop_transitions_loop ON loop_transitions (project_id, loop_name, id);
