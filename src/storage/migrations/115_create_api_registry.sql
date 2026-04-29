CREATE TABLE IF NOT EXISTS api_coordinators (
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  url TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (host, port)
);

CREATE TABLE IF NOT EXISTS api_project_instances (
  instance_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  directory TEXT NOT NULL,
  owner_url TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_project_instances_project ON api_project_instances(project_id);
CREATE INDEX IF NOT EXISTS idx_api_project_instances_directory ON api_project_instances(directory);
CREATE INDEX IF NOT EXISTS idx_api_project_instances_expiry ON api_project_instances(expires_at);
