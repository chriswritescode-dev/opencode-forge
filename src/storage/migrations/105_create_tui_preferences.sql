CREATE TABLE IF NOT EXISTS tui_preferences (
  project_id   TEXT NOT NULL,
  key          TEXT NOT NULL,
  data         TEXT NOT NULL,
  expires_at   INTEGER,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_tui_preferences_expires_at
  ON tui_preferences(expires_at) WHERE expires_at IS NOT NULL;
