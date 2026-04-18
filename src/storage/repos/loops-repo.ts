import type { Database } from 'bun:sqlite'
import { findPartialMatch } from '../../utils/partial-match'

export interface LoopRow {
  projectId: string
  loopName: string
  status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'
  currentSessionId: string
  worktree: boolean
  worktreeDir: string
  worktreeBranch: string | null
  projectDir: string
  maxIterations: number
  iteration: number
  auditCount: number
  errorCount: number
  phase: 'coding' | 'auditing'
  audit: boolean
  completionSignal: string | null
  executionModel: string | null
  auditorModel: string | null
  modelFailed: boolean
  sandbox: boolean
  sandboxContainer: string | null
  startedAt: number
  completedAt: number | null
  terminationReason: string | null
  completionSummary: string | null
  workspaceId: string | null
}

export interface LoopLargeFields {
  prompt: string | null
  lastAuditResult: string | null
}

export interface LoopsRepo {
  insert(row: LoopRow, large: LoopLargeFields): boolean
  get(projectId: string, loopName: string): LoopRow | null
  getLarge(projectId: string, loopName: string): LoopLargeFields | null
  getBySessionId(projectId: string, sessionId: string): LoopRow | null
  listByStatus(projectId: string, statuses: LoopRow['status'][]): LoopRow[]
  updatePhase(projectId: string, loopName: string, phase: 'coding' | 'auditing'): void
  updateIteration(projectId: string, loopName: string, iteration: number): void
  incrementError(projectId: string, loopName: string): number
  resetError(projectId: string, loopName: string): void
  incrementAudit(projectId: string, loopName: string): number
  setAuditCount(projectId: string, loopName: string, count: number): void
  setCurrentSessionId(projectId: string, loopName: string, sessionId: string): void
  setWorkspaceId(projectId: string, loopName: string, workspaceId: string): void
  setModelFailed(projectId: string, loopName: string, failed: boolean): void
  setLastAuditResult(projectId: string, loopName: string, text: string | null): void
  setSandboxContainer(projectId: string, loopName: string, containerName: string | null): void
  setPhaseAndResetError(projectId: string, loopName: string, phase: 'coding' | 'auditing'): void
  setStatus(projectId: string, loopName: string, status: LoopRow['status']): void
  updatePrompt(projectId: string, loopName: string, prompt: string): boolean
  applyRotation(
    projectId: string,
    loopName: string,
    opts: { sessionId: string; iteration: number; phase?: 'coding' | 'auditing'; auditCount?: number; lastAuditResult?: string | null; resetError?: boolean }
  ): void
  terminate(
    projectId: string,
    loopName: string,
    opts: {
      status: Exclude<LoopRow['status'], 'running'>
      reason: string
      completedAt: number
      summary?: string
    }
  ): void
  delete(projectId: string, loopName: string): void
  findPartial(projectId: string, name: string): { match: LoopRow | null; candidates: LoopRow[] }
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
    completionSignal: row.completion_signal,
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
  completion_signal: string | null
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

export function createLoopsRepo(db: Database): LoopsRepo {
  const insertStmt = db.prepare(`
    INSERT INTO loops (
      project_id, loop_name, status, current_session_id, worktree, worktree_dir,
      worktree_branch, project_dir, max_iterations, iteration, audit_count,
      error_count, phase, audit, completion_signal, execution_model, auditor_model,
      model_failed, sandbox, sandbox_container, started_at, completed_at,
      termination_reason, completion_summary, workspace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const upsertLargeStmt = db.prepare(`
    INSERT INTO loop_large_fields (project_id, loop_name, prompt, last_audit_result)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (project_id, loop_name) DO UPDATE SET
      prompt = excluded.prompt,
      last_audit_result = excluded.last_audit_result
  `)

  const getStmt = db.prepare(`
    SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir,
           worktree_branch, project_dir, max_iterations, iteration, audit_count,
           error_count, phase, audit, completion_signal, execution_model, auditor_model,
           model_failed, sandbox, sandbox_container, started_at, completed_at,
           termination_reason, completion_summary, workspace_id
    FROM loops
    WHERE project_id = ? AND loop_name = ?
  `)

  const getLargeStmt = db.prepare(`
    SELECT prompt, last_audit_result
    FROM loop_large_fields
    WHERE project_id = ? AND loop_name = ?
  `)

  const getBySessionIdStmt = db.prepare(`
    SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir,
           worktree_branch, project_dir, max_iterations, iteration, audit_count,
           error_count, phase, audit, completion_signal, execution_model, auditor_model,
           model_failed, sandbox, sandbox_container, started_at, completed_at,
           termination_reason, completion_summary, workspace_id
    FROM loops
    WHERE project_id = ? AND current_session_id = ?
  `)

  const listByStatusBase = `
    SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir,
           worktree_branch, project_dir, max_iterations, iteration, audit_count,
           error_count, phase, audit, completion_signal, execution_model, auditor_model,
           model_failed, sandbox, sandbox_container, started_at, completed_at,
           termination_reason, completion_summary, workspace_id
    FROM loops
    WHERE project_id = ? AND status IN
  `

  const updatePhaseStmt = db.prepare(`
    UPDATE loops SET phase = ? WHERE project_id = ? AND loop_name = ?
  `)

  const updateIterationStmt = db.prepare(`
    UPDATE loops SET iteration = ? WHERE project_id = ? AND loop_name = ?
  `)

  const incrementErrorStmt = db.prepare(`
    UPDATE loops SET error_count = error_count + 1
    WHERE project_id = ? AND loop_name = ?
    RETURNING error_count
  `)

  const resetErrorStmt = db.prepare(`
    UPDATE loops SET error_count = 0, model_failed = 0
    WHERE project_id = ? AND loop_name = ?
  `)

  const incrementAuditStmt = db.prepare(`
    UPDATE loops SET audit_count = audit_count + 1
    WHERE project_id = ? AND loop_name = ?
    RETURNING audit_count
  `)

  const setAuditCountStmt = db.prepare(`
    UPDATE loops SET audit_count = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const setCurrentSessionIdStmt = db.prepare(`
    UPDATE loops SET current_session_id = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const setWorkspaceIdStmt = db.prepare(`
    UPDATE loops SET workspace_id = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const setModelFailedStmt = db.prepare(`
    UPDATE loops SET model_failed = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const setLastAuditResultStmt = db.prepare(`
    UPDATE loop_large_fields SET last_audit_result = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const setSandboxContainerStmt = db.prepare(`
    UPDATE loops SET sandbox_container = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const setStatusStmt = db.prepare(`
    UPDATE loops SET status = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const updatePromptStmt = db.prepare(`
    UPDATE loop_large_fields
    SET prompt = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const setPhaseAndResetErrorStmt = db.prepare(`
    UPDATE loops SET phase = ?, error_count = 0, model_failed = 0
    WHERE project_id = ? AND loop_name = ?
  `)

  const applyRotationStmt = db.prepare(`
    UPDATE loops SET
      current_session_id = ?,
      iteration = ?,
      phase = COALESCE(?, phase),
      audit_count = COALESCE(?, audit_count)
    WHERE project_id = ? AND loop_name = ?
  `)

  const terminateStmt = db.prepare(`
    UPDATE loops SET
      status = ?,
      completed_at = ?,
      termination_reason = ?,
      completion_summary = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const deleteStmt = db.prepare(`
    DELETE FROM loops WHERE project_id = ? AND loop_name = ?
  `)

  const deleteLargeStmt = db.prepare(`
    DELETE FROM loop_large_fields WHERE project_id = ? AND loop_name = ?
  `)

  return {
    insert(row: LoopRow, large: LoopLargeFields): boolean {
      const result = insertStmt.run(
        row.projectId,
        row.loopName,
        row.status,
        row.currentSessionId,
        row.worktree ? 1 : 0,
        row.worktreeDir,
        row.worktreeBranch,
        row.projectDir,
        row.maxIterations,
        row.iteration,
        row.auditCount,
        row.errorCount,
        row.phase,
        row.audit ? 1 : 0,
        row.completionSignal,
        row.executionModel,
        row.auditorModel,
        row.modelFailed ? 1 : 0,
        row.sandbox ? 1 : 0,
        row.sandboxContainer,
        row.startedAt,
        row.completedAt,
        row.terminationReason,
        row.completionSummary,
        row.workspaceId
      )
      if (result.changes === 0) {
        // Conflict - row already exists
        return false
      }
      upsertLargeStmt.run(row.projectId, row.loopName, large.prompt, large.lastAuditResult)
      return true
    },

    get(projectId: string, loopName: string): LoopRow | null {
      const row = getStmt.get(projectId, loopName) as LoopRowRaw | null
      return row ? mapRow(row) : null
    },

    getLarge(projectId: string, loopName: string): LoopLargeFields | null {
      const row = getLargeStmt.get(projectId, loopName) as { prompt: string | null; last_audit_result: string | null } | null
      if (!row) return null
      return {
        prompt: row.prompt,
        lastAuditResult: row.last_audit_result,
      }
    },

    getBySessionId(projectId: string, sessionId: string): LoopRow | null {
      const row = getBySessionIdStmt.get(projectId, sessionId) as LoopRowRaw | null
      return row ? mapRow(row) : null
    },

    listByStatus(projectId: string, statuses: LoopRow['status'][]): LoopRow[] {
      if (statuses.length === 0) return []
      const placeholders = statuses.map(() => '?').join(',')
      const sql = `${listByStatusBase} (${placeholders}) ORDER BY started_at DESC`
      const stmt = db.prepare(sql)
      const rows = stmt.all(projectId, ...statuses) as LoopRowRaw[]
      return rows.map(mapRow)
    },

    updatePhase(projectId: string, loopName: string, phase: 'coding' | 'auditing'): void {
      updatePhaseStmt.run(phase, projectId, loopName)
    },

    updateIteration(projectId: string, loopName: string, iteration: number): void {
      updateIterationStmt.run(iteration, projectId, loopName)
    },

    incrementError(projectId: string, loopName: string): number {
      const result = incrementErrorStmt.get(projectId, loopName) as { error_count: number } | null
      return result?.error_count ?? 0
    },

    resetError(projectId: string, loopName: string): void {
      resetErrorStmt.run(projectId, loopName)
    },

    incrementAudit(projectId: string, loopName: string): number {
      const result = incrementAuditStmt.get(projectId, loopName) as { audit_count: number } | null
      return result?.audit_count ?? 0
    },

    setAuditCount(projectId: string, loopName: string, count: number): void {
      setAuditCountStmt.run(count, projectId, loopName)
    },

    setCurrentSessionId(projectId: string, loopName: string, sessionId: string): void {
      setCurrentSessionIdStmt.run(sessionId, projectId, loopName)
    },

    setWorkspaceId(projectId: string, loopName: string, workspaceId: string): void {
      setWorkspaceIdStmt.run(workspaceId, projectId, loopName)
    },

    setModelFailed(projectId: string, loopName: string, failed: boolean): void {
      setModelFailedStmt.run(failed ? 1 : 0, projectId, loopName)
    },

    setLastAuditResult(projectId: string, loopName: string, text: string | null): void {
      setLastAuditResultStmt.run(text, projectId, loopName)
    },

    setSandboxContainer(projectId: string, loopName: string, containerName: string | null): void {
      setSandboxContainerStmt.run(containerName, projectId, loopName)
    },

    setPhaseAndResetError(projectId: string, loopName: string, phase: 'coding' | 'auditing'): void {
      setPhaseAndResetErrorStmt.run(phase, projectId, loopName)
    },

    setStatus(projectId: string, loopName: string, status: LoopRow['status']): void {
      setStatusStmt.run(status, projectId, loopName)
    },

    updatePrompt(projectId: string, loopName: string, prompt: string): boolean {
      const result = updatePromptStmt.run(prompt, projectId, loopName)
      return result.changes > 0
    },

    applyRotation(
      projectId: string,
      loopName: string,
      opts: { sessionId: string; iteration: number; phase?: 'coding' | 'auditing'; auditCount?: number; lastAuditResult?: string | null; resetError?: boolean }
    ): void {
      const runTxn = db.transaction(() => {
        applyRotationStmt.run(
          opts.sessionId,
          opts.iteration,
          opts.phase ?? null,
          opts.auditCount ?? null,
          projectId,
          loopName
        )
        if (opts.lastAuditResult !== undefined) {
          setLastAuditResultStmt.run(opts.lastAuditResult ?? null, projectId, loopName)
        }
        if (opts.resetError) {
          resetErrorStmt.run(projectId, loopName)
        }
      })
      runTxn()
    },

    terminate(
      projectId: string,
      loopName: string,
      opts: {
        status: Exclude<LoopRow['status'], 'running'>
        reason: string
        completedAt: number
        summary?: string
      }
    ): void {
      terminateStmt.run(opts.status, opts.completedAt, opts.reason, opts.summary ?? null, projectId, loopName)
    },

    delete(projectId: string, loopName: string): void {
      deleteStmt.run(projectId, loopName)
      deleteLargeStmt.run(projectId, loopName)
    },

    findPartial(projectId: string, name: string): { match: LoopRow | null; candidates: LoopRow[] } {
      const all = this.listByStatus(projectId, ['running', 'completed', 'cancelled', 'errored', 'stalled'])
      return findPartialMatch(name, all, (row: LoopRow) => [row.loopName, row.worktreeBranch ?? undefined])
    },
  }
}
