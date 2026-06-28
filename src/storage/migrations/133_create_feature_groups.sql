-- Migration 133: Create feature_groups and group_features tables for group-launch
-- feature-group orchestration. Tracks feature groups and their individual features
-- through the extraction → planning → running lifecycle.

CREATE TABLE IF NOT EXISTS feature_groups (
  project_id          TEXT NOT NULL,
  group_id            TEXT NOT NULL,
  title               TEXT NOT NULL,
  status              TEXT NOT NULL CHECK(status IN ('extracting','planning','running','completed','cancelled','errored','interrupted')),
  prd_text            TEXT,
  max_concurrent      INTEGER NOT NULL DEFAULT 3,
  execution_model     TEXT,
  auditor_model       TEXT,
  splitter_session_id TEXT,
  host_session_id     TEXT,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  PRIMARY KEY (project_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_feature_groups_status ON feature_groups(project_id, status);
CREATE INDEX IF NOT EXISTS idx_feature_groups_splitter ON feature_groups(project_id, splitter_session_id);

CREATE TABLE IF NOT EXISTS group_features (
  project_id           TEXT NOT NULL,
  group_id             TEXT NOT NULL,
  feature_index        INTEGER NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL,
  stage                TEXT NOT NULL CHECK(stage IN ('pending','planning','planned','launching','running','completed','failed','cancelled')),
  architect_session_id TEXT,
  loop_name            TEXT,
  error                TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (project_id, group_id, feature_index),
  FOREIGN KEY (project_id, group_id) REFERENCES feature_groups(project_id, group_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_features_arch ON group_features(project_id, architect_session_id);
CREATE INDEX IF NOT EXISTS idx_group_features_loop ON group_features(project_id, loop_name);
CREATE INDEX IF NOT EXISTS idx_group_features_stage ON group_features(project_id, group_id, stage);
