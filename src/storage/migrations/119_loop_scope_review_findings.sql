-- Migration 119: Replace branch-scope with loop-scope for review_findings.
-- Drops all existing findings (per design decision: ephemeral, fresh slate).
DROP TABLE IF EXISTS review_findings;

CREATE TABLE review_findings (
  project_id   TEXT NOT NULL,
  loop_name    TEXT NOT NULL DEFAULT '',
  file         TEXT NOT NULL,
  line         INTEGER NOT NULL,
  severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
  description  TEXT NOT NULL,
  scenario     TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, loop_name, file, line)
);

CREATE INDEX idx_review_findings_loop_name ON review_findings(project_id, loop_name);
