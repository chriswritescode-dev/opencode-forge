CREATE TABLE IF NOT EXISTS section_dependencies (
  project_id            TEXT NOT NULL,
  loop_name             TEXT NOT NULL,
  section_id            TEXT NOT NULL,
  depends_on_section_id TEXT NOT NULL,
  PRIMARY KEY (project_id, loop_name, section_id, depends_on_section_id),
  FOREIGN KEY (project_id, loop_name)
    REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
);
INSERT OR IGNORE INTO section_dependencies (project_id, loop_name, section_id, depends_on_section_id)
SELECT project_id, loop_name, 'section-' || (section_index + 1), 'section-' || section_index
FROM section_plans
WHERE section_index > 0;
