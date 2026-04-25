CREATE TABLE IF NOT EXISTS review_findings (
  project_id   TEXT NOT NULL,
  file         TEXT NOT NULL,
  line         INTEGER NOT NULL,
  severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
  description  TEXT NOT NULL,
  scenario     TEXT,
  branch       TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, file, line)
);
CREATE INDEX IF NOT EXISTS idx_review_findings_branch ON review_findings(project_id, branch);
