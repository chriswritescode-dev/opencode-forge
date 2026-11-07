ALTER TABLE section_plans ADD COLUMN section_id TEXT NOT NULL DEFAULT '';
UPDATE section_plans SET section_id = 'section-' || (section_index + 1) WHERE section_id = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_section_plans_section_id ON section_plans(project_id, loop_name, section_id);
