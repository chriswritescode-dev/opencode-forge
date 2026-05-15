-- Migration 127: Consolidate loop plan storage.
-- Backfill loop_large_fields.prompt into plans as loop-scoped plan content.
-- Remove the prompt column from loop_large_fields.

-- 1. Backfill non-null, non-empty prompts into plans (prompt content wins on conflict)
INSERT INTO plans (project_id, loop_name, content, updated_at)
SELECT project_id, loop_name, prompt, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM loop_large_fields
WHERE prompt IS NOT NULL AND trim(prompt) != ''
ON CONFLICT(project_id, loop_name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at;

-- 2. Rebuild loop_large_fields without prompt column
CREATE TABLE loop_large_fields_new (
  project_id          TEXT NOT NULL,
  loop_name           TEXT NOT NULL,
  last_audit_result   TEXT,
  PRIMARY KEY (project_id, loop_name),
  FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
);

INSERT INTO loop_large_fields_new SELECT project_id, loop_name, last_audit_result FROM loop_large_fields;

DROP TABLE loop_large_fields;
ALTER TABLE loop_large_fields_new RENAME TO loop_large_fields;

-- 3. Add index for recent plan listing by project and updated_at
CREATE INDEX IF NOT EXISTS idx_plans_project_updated_at ON plans(project_id, updated_at DESC);
