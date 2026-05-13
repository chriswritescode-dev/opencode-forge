ALTER TABLE review_findings ADD COLUMN section_index INTEGER;
CREATE INDEX IF NOT EXISTS idx_review_findings_section
  ON review_findings(project_id, loop_name, section_index);
