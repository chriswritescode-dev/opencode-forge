-- Migration 117: Add branch to primary key for review_findings
-- This allows the same file:line to have findings on different branches

-- Step 1: Create new table with branch in primary key
CREATE TABLE review_findings_new (
  project_id   TEXT NOT NULL,
  branch       TEXT NOT NULL DEFAULT '',
  file         TEXT NOT NULL,
  line         INTEGER NOT NULL,
  severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
  description  TEXT NOT NULL,
  scenario     TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, branch, file, line)
);

-- Step 2: Copy existing data, treating NULL branch as empty string
INSERT INTO review_findings_new (project_id, branch, file, line, severity, description, scenario, created_at)
SELECT project_id, COALESCE(branch, ''), file, line, severity, description, scenario, created_at
FROM review_findings;

-- Step 3: Drop old table and rename new one
DROP TABLE review_findings;
ALTER TABLE review_findings_new RENAME TO review_findings;

-- Step 4: Recreate index with branch
CREATE INDEX IF NOT EXISTS idx_review_findings_branch ON review_findings(project_id, branch);
