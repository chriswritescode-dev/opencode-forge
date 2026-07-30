CREATE TABLE IF NOT EXISTS goal_briefs (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  content    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id)
);
