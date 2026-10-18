-- Migration 153: Create goals and goal_chunks tables for goal orchestration.
-- A goal is an objective executed as an ordered series of plan-loop chunks; the
-- goal row snapshots the first chunk's launch settings (models, sandbox, max
-- iterations) so every later chunk reuses them. goal_chunks tracks each chunk's
-- lifecycle. There is deliberately no foreign key to loops: loop rows are swept
-- after a TTL, so a chunk keeps loop_name/branch as plain text.

CREATE TABLE IF NOT EXISTS goals (
  project_id        TEXT NOT NULL,
  goal_id           TEXT NOT NULL,
  title             TEXT NOT NULL,
  objective         TEXT NOT NULL,
  tasks             TEXT NOT NULL DEFAULT '[]',
  host_session_id   TEXT NOT NULL,
  project_dir       TEXT,
  status            TEXT NOT NULL CHECK(status IN ('draft','running','paused','completed','cancelled')),
  max_chunks        INTEGER NOT NULL,
  execution_model   TEXT,
  auditor_model     TEXT,
  execution_variant TEXT,
  auditor_variant   TEXT,
  sandbox_settings  TEXT,
  max_iterations    INTEGER,
  error             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  PRIMARY KEY (project_id, goal_id)
);

CREATE INDEX IF NOT EXISTS idx_goals_session ON goals (project_id, host_session_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_one_draft ON goals (project_id, host_session_id) WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS goal_chunks (
  project_id         TEXT NOT NULL,
  goal_id            TEXT NOT NULL,
  chunk_index        INTEGER NOT NULL,
  stage              TEXT NOT NULL CHECK(stage IN ('planning','launching','running','completed','cancelled')),
  title              TEXT,
  planner_session_id TEXT,
  planning_dir       TEXT,
  base_commit        TEXT,
  loop_name          TEXT,
  branch             TEXT,
  summary            TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, goal_id, chunk_index),
  FOREIGN KEY (project_id, goal_id) REFERENCES goals(project_id, goal_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_chunks_loop ON goal_chunks (project_id, loop_name) WHERE loop_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_goal_chunks_planner ON goal_chunks (project_id, planner_session_id) WHERE planner_session_id IS NOT NULL;
