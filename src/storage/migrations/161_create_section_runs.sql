CREATE TABLE IF NOT EXISTS section_runs (
  project_id TEXT NOT NULL,
  loop_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('section','plan','post_action')),
  section_id TEXT NOT NULL DEFAULT '',
  section_index INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL CHECK(phase IN ('coding','auditing','post_action')),
  session_id TEXT NOT NULL,
  standby_session_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','finished')),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (project_id, loop_name, kind, section_id),
  FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_section_runs_one_active ON section_runs(project_id, loop_name) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_section_runs_session ON section_runs(project_id, session_id);
