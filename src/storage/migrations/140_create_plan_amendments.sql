-- Migration 140: Create plan_amendments table for recording adaptive-plan adjustments.
-- Captures before/after section snapshots when the auditor replaces pending sections
-- of a running loop. Foreign keys to loops(project_id, loop_name) with ON DELETE
-- CASCADE so amendments are pruned automatically when a loop row is deleted.

CREATE TABLE IF NOT EXISTS plan_amendments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         TEXT NOT NULL,
  loop_name          TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT 'auditor',
  rationale          TEXT NOT NULL,
  applied_at_section INTEGER NOT NULL,
  sections_before    TEXT NOT NULL,
  sections_after     TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plan_amendments_loop ON plan_amendments (project_id, loop_name, id);
