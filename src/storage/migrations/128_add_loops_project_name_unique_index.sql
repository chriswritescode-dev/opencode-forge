CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_project_name
  ON loops(project_id, loop_name);
