-- Migration 154 (part 2): Reopen the persisted last section of a running loop
-- caught in a retired final-audit phase, so it becomes a normal section
-- audit/coding state. Split out because legacy databases can record migration
-- 121 without the section_plans table; the runner guards this file on its
-- existence.

UPDATE section_plans
SET status = 'in_progress',
    completed_at = NULL
WHERE status = 'completed'
  AND EXISTS (
    SELECT 1
    FROM loops
    WHERE loops.project_id = section_plans.project_id
      AND loops.loop_name = section_plans.loop_name
      AND loops.status = 'running'
      AND loops.phase IN ('final_auditing', 'final_audit_fix')
      AND loops.current_section_index = section_plans.section_index
  );
