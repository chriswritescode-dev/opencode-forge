-- Make scenario column nullable in review_findings table
-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table
CREATE TABLE review_findings_new (
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

-- Copy data from old table to new table
INSERT INTO review_findings_new SELECT * FROM review_findings;

-- Drop old table and rename new table
DROP TABLE review_findings;
ALTER TABLE review_findings_new RENAME TO review_findings;

-- Recreate the index
CREATE INDEX IF NOT EXISTS idx_review_findings_branch ON review_findings(project_id, branch);
