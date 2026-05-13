ALTER TABLE loops ADD COLUMN decomposition_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (decomposition_status IN ('pending','running','completed','failed','skipped'));
ALTER TABLE loops ADD COLUMN decomposition_mode TEXT NOT NULL DEFAULT 'agent'
  CHECK (decomposition_mode IN ('agent','deterministic'));
ALTER TABLE loops ADD COLUMN decomposition_session_id TEXT;
ALTER TABLE loops ADD COLUMN current_section_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loops ADD COLUMN total_sections INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loops ADD COLUMN final_audit_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loops ADD COLUMN final_audit_attempts INTEGER NOT NULL DEFAULT 0;
