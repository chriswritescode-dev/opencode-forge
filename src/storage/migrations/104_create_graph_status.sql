CREATE TABLE IF NOT EXISTS graph_status (
  project_id   TEXT NOT NULL,
  cwd          TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL,
  ready        INTEGER NOT NULL,
  stats_json   TEXT,
  message      TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, cwd)
);
