-- Migration 125: Rebuild review_findings to include section_index in the primary key.
-- This allows different sections to report findings on the same file:line without
-- conflict (SQLite treats NULL as distinct in UNIQUE constraints).
DROP TABLE IF EXISTS review_findings_new;

CREATE TABLE review_findings_new (
  project_id   TEXT NOT NULL,
  loop_name    TEXT NOT NULL DEFAULT '',
  file         TEXT NOT NULL,
  line         INTEGER NOT NULL,
  severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
  description  TEXT NOT NULL,
  scenario     TEXT,
  section_index INTEGER,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, loop_name, file, line, section_index)
);

INSERT INTO review_findings_new (project_id, loop_name, file, line, severity, description, scenario, section_index, created_at)
  SELECT project_id, loop_name, file, line, severity, description, scenario, COALESCE(section_index, -1), created_at FROM review_findings;
DROP TABLE review_findings;
ALTER TABLE review_findings_new RENAME TO review_findings;

CREATE INDEX IF NOT EXISTS idx_review_findings_loop_name ON review_findings(project_id, loop_name);
CREATE INDEX IF NOT EXISTS idx_review_findings_section ON review_findings(project_id, loop_name, section_index);
