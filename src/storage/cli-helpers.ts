import type { Database } from 'bun:sqlite'
import type { LoopRow, LoopLargeFields } from './repos/loops-repo'

export interface LoopEntry {
  row: LoopRow
  large: LoopLargeFields | null
}

/**
 * Reads all loops from the loops table, optionally scoped to a projectId.
 * Returns LoopRow with LoopLargeFields for complete state reconstruction.
 */
export function listLoopsFromDb(
  db: Database,
  projectId: string | undefined,
  options?: { statuses?: LoopRow['status'][]; activeOnly?: boolean },
): LoopEntry[] {
  const statuses = options?.statuses ?? ['running', 'completed', 'cancelled', 'errored', 'stalled']
  const activeOnly = options?.activeOnly ?? false
  
  const placeholders = statuses.map(() => '?').join(',')
  const baseQuery = `
    SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir,
           worktree_branch, project_dir, max_iterations, iteration, audit_count,
           error_count, phase, audit, execution_model, auditor_model,
           model_failed, sandbox, sandbox_container, started_at, completed_at,
           termination_reason, completion_summary, workspace_id
    FROM loops
    WHERE project_id = ? AND status IN (${placeholders})
  `
  
  const params = [projectId ?? '', ...statuses]
  const rows = db.prepare(baseQuery).all(...params) as LoopRowRaw[]
  
  const entries: LoopEntry[] = []
  for (const row of rows) {
    const loopRow = mapRow(row)
    if (activeOnly && loopRow.status !== 'running') continue
    
    const large = db.prepare(`
      SELECT prompt, last_audit_result
      FROM loop_large_fields
      WHERE project_id = ? AND loop_name = ?
    `).get(loopRow.projectId, loopRow.loopName) as { prompt: string | null; last_audit_result: string | null } | null
    
    entries.push({
      row: loopRow,
      large: large ? {
        prompt: large.prompt,
        lastAuditResult: large.last_audit_result,
      } : null,
    })
  }
  
  return entries
}

interface LoopRowRaw {
  project_id: string
  loop_name: string
  status: string
  current_session_id: string
  worktree: number
  worktree_dir: string
  worktree_branch: string | null
  project_dir: string
  max_iterations: number
  iteration: number
  audit_count: number
  error_count: number
  phase: string
  audit: number
  execution_model: string | null
  auditor_model: string | null
  model_failed: number
  sandbox: number
  sandbox_container: string | null
  started_at: number
  completed_at: number | null
  termination_reason: string | null
  completion_summary: string | null
  workspace_id: string | null
}

function mapRow(row: LoopRowRaw): LoopRow {
  return {
    projectId: row.project_id,
    loopName: row.loop_name,
    status: row.status as LoopRow['status'],
    currentSessionId: row.current_session_id,
    worktree: row.worktree === 1,
    worktreeDir: row.worktree_dir,
    worktreeBranch: row.worktree_branch,
    projectDir: row.project_dir,
    maxIterations: row.max_iterations,
    iteration: row.iteration,
    auditCount: row.audit_count,
    errorCount: row.error_count,
    phase: row.phase as LoopRow['phase'],
    audit: row.audit === 1,
    executionModel: row.execution_model,
    auditorModel: row.auditor_model,
    modelFailed: row.model_failed === 1,
    sandbox: row.sandbox === 1,
    sandboxContainer: row.sandbox_container,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    terminationReason: row.termination_reason,
    completionSummary: row.completion_summary,
    workspaceId: row.workspace_id,
  }
}
