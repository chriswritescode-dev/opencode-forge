CREATE TABLE IF NOT EXISTS loop_handoffs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  loop_name     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('coder','auditor','post_action')),
  phase         TEXT NOT NULL,
  section_index INTEGER,
  iteration     INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('pending','applied','discarded')),
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_handoffs_pending ON loop_handoffs (project_id, loop_name) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_loop_handoffs_loop ON loop_handoffs (project_id, loop_name, id);
