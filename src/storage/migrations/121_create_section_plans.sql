CREATE TABLE IF NOT EXISTS section_plans (
  project_id    TEXT    NOT NULL,
  loop_name     TEXT    NOT NULL,
  section_index INTEGER NOT NULL,
  title         TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  summary_done           TEXT,
  summary_deviations     TEXT,
  summary_follow_ups     TEXT,
  started_at    INTEGER,
  completed_at  INTEGER,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, loop_name, section_index),
  FOREIGN KEY (project_id, loop_name)
    REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_section_plans_status
  ON section_plans(project_id, loop_name, status);
