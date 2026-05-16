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
  phase: 'coding' | 'auditing' | 'final_auditing'
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
  hostSessionId: string | null
  currentSectionIndex: number
  totalSections: number
  finalAuditDone: number
}

export interface LoopLargeFields {
  lastAuditResult: string | null
}

export interface LoopsRepo {
  insert(row: LoopRow, large: LoopLargeFields): boolean
  get(projectId: string, loopName: string): LoopRow | null
  getLarge(projectId: string, loopName: string): LoopLargeFields | null
  getBySessionId(projectId: string, sessionId: string): LoopRow | null
  listByStatus(projectId: string, statuses: LoopRow['status'][]): LoopRow[]
  listAll(projectId: string): LoopRow[]
  updatePhase(projectId: string, loopName: string, phase: LoopRow['phase']): void
  updateIteration(projectId: string, loopName: string, iteration: number): void
  incrementError(projectId: string, loopName: string): number
  resetError(projectId: string, loopName: string): void
  setCurrentSessionId(projectId: string, loopName: string, sessionId: string): void
  setWorkspaceId(projectId: string, loopName: string, workspaceId: string): void
  clearWorkspaceId(projectId: string, loopName: string): void
  setModelFailed(projectId: string, loopName: string, failed: boolean): void
  setLastAuditResult(projectId: string, loopName: string, text: string): void
  clearLastAuditResult(projectId: string, loopName: string): void
  setSandboxContainer(projectId: string, loopName: string, containerName: string | null): void
  setPhaseAndResetError(projectId: string, loopName: string, phase: LoopRow['phase']): void
  setStatus(projectId: string, loopName: string, status: LoopRow['status']): void
  replaceSession(
    projectId: string,
    loopName: string,
    opts: { sessionId: string; phase: LoopRow['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }
  ): void
  restart(
    projectId: string,
    loopName: string,
    opts: {
      sessionId: string
      phase: LoopRow['phase']
      iteration: number
      auditCount: number
      sandbox: boolean
      sandboxContainer: string | null
      workspaceId: string | null
      currentSectionIndex: number
      totalSections: number
      finalAuditDone: boolean
      startedAt: number
    }
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
  setCurrentSectionIndex(projectId: string, loopName: string, index: number): void
  setTotalSections(projectId: string, loopName: string, total: number): void
  setFinalAuditDone(projectId: string, loopName: string, done: boolean): void
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
    hostSessionId: row.host_session_id,
    currentSectionIndex: row.current_section_index,
    totalSections: row.total_sections,
    finalAuditDone: row.final_audit_done,
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
  host_session_id: string | null
  current_section_index: number
  total_sections: number
  final_audit_done: number
}

export function createLoopsRepo(db: Database): LoopsRepo {
  const insertStmt = db.prepare(`
    INSERT INTO loops (
      project_id, loop_name, status, current_session_id, worktree, worktree_dir,
      worktree_branch, project_dir, max_iterations, iteration, audit_count,
      error_count, phase, execution_model, auditor_model,
      model_failed, sandbox, sandbox_container, started_at, completed_at,
      termination_reason, completion_summary, workspace_id, host_session_id,
      current_section_index, total_sections, final_audit_done
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const upsertLargeStmt = db.prepare(`
    INSERT INTO loop_large_fields (project_id, loop_name, last_audit_result)
    VALUES (?, ?, ?)
    ON CONFLICT (project_id, loop_name) DO UPDATE SET
      last_audit_result = excluded.last_audit_result
  `)

  const getStmt = db.prepare(`
    SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir,
           worktree_branch, project_dir, max_iterations, iteration, audit_count,
           error_count, phase, execution_model, auditor_model,
           model_failed, sandbox, sandbox_container, started_at, completed_at,
           termination_reason, completion_summary, workspace_id, host_session_id,
           current_section_index, total_sections, final_audit_done
    FROM loops
    WHERE project_id = ? AND loop_name = ?
  `)

  const getLargeStmt = db.prepare(`
    SELECT last_audit_result
    FROM loop_large_fields
    WHERE project_id = ? AND loop_name = ?
  `)

  const getBySessionIdStmt = db.prepare(`
    SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir,
           worktree_branch, project_dir, max_iterations, iteration, audit_count,
           error_count, phase, execution_model, auditor_model,
           model_failed, sandbox, sandbox_container, started_at, completed_at,
           termination_reason, completion_summary, workspace_id, host_session_id,
           current_section_index, total_sections, final_audit_done
    FROM loops
    WHERE project_id = ? AND current_session_id = ?
  `)

  const listByStatusBase = `
    SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir,
           worktree_branch, project_dir, max_iterations, iteration, audit_count,
           error_count, phase, execution_model, auditor_model,
           model_failed, sandbox, sandbox_container, started_at, completed_at,
           termination_reason, completion_summary, workspace_id, host_session_id,
           current_section_index, total_sections, final_audit_done
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

  const setCurrentSessionIdStmt = db.prepare(`
    UPDATE loops SET current_session_id = ?
    WHERE project_id = ? AND loop_name = ?
  `)



  const setWorkspaceIdStmt = db.prepare(`
    UPDATE loops SET workspace_id = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const clearWorkspaceIdStmt = db.prepare(`
    UPDATE loops SET workspace_id = NULL
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

  const clearLastAuditResultStmt = db.prepare(`
    UPDATE loop_large_fields SET last_audit_result = NULL
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

  const setPhaseAndResetErrorStmt = db.prepare(`
    UPDATE loops SET phase = ?, error_count = 0, model_failed = 0
    WHERE project_id = ? AND loop_name = ?
  `)

  const replaceSessionStmt = db.prepare(`
    UPDATE loops SET
      current_session_id = ?,
      phase = ?,
      iteration = COALESCE(?, iteration),
      audit_count = COALESCE(?, audit_count)
    WHERE project_id = ? AND loop_name = ?
  `)

  const restartStmt = db.prepare(`
    UPDATE loops SET
      status = 'running',
      current_session_id = ?,
      phase = ?,
      iteration = ?,
      audit_count = ?,
      error_count = 0,
      model_failed = 0,
      sandbox = ?,
      sandbox_container = ?,
      workspace_id = ?,
      started_at = ?,
      completed_at = NULL,
      termination_reason = NULL,
      completion_summary = NULL,
      current_section_index = ?,
      total_sections = ?,
      final_audit_done = ?
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
        row.executionModel,
        row.auditorModel,
        row.modelFailed ? 1 : 0,
        row.sandbox ? 1 : 0,
        row.sandboxContainer,
        row.startedAt,
        row.completedAt,
        row.terminationReason,
        row.completionSummary,
        row.workspaceId,
        row.hostSessionId,
        row.currentSectionIndex ?? 0,
        row.totalSections ?? 0,
        row.finalAuditDone ?? 0,
      ) as unknown as { changes: number }
      if (result.changes === 0) {
        return false
      }
      upsertLargeStmt.run(row.projectId, row.loopName, large.lastAuditResult)
      return true
    },

    get(projectId: string, loopName: string): LoopRow | null {
      const row = getStmt.get(projectId, loopName) as LoopRowRaw | null
      return row ? mapRow(row) : null
    },

    getLarge(projectId: string, loopName: string): LoopLargeFields | null {
      const row = getLargeStmt.get(projectId, loopName) as { last_audit_result: string | null } | null
      if (!row) return null
      return {
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

    listAll(projectId: string): LoopRow[] {
      const allStatuses: LoopRow['status'][] = ['running', 'completed', 'cancelled', 'errored', 'stalled']
      return this.listByStatus(projectId, allStatuses)
    },

    updatePhase(projectId: string, loopName: string, phase: LoopRow['phase']): void {
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

    setCurrentSessionId(projectId: string, loopName: string, sessionId: string): void {
      setCurrentSessionIdStmt.run(sessionId, projectId, loopName)
    },

    setWorkspaceId(projectId: string, loopName: string, workspaceId: string): void {
      setWorkspaceIdStmt.run(workspaceId, projectId, loopName)
    },

    clearWorkspaceId(projectId: string, loopName: string): void {
      clearWorkspaceIdStmt.run(projectId, loopName)
    },

    setModelFailed(projectId: string, loopName: string, failed: boolean): void {
      setModelFailedStmt.run(failed ? 1 : 0, projectId, loopName)
    },

    setLastAuditResult(projectId: string, loopName: string, text: string): void {
      if (text === '') return
      setLastAuditResultStmt.run(text, projectId, loopName)
    },

    clearLastAuditResult(projectId: string, loopName: string): void {
      clearLastAuditResultStmt.run(projectId, loopName)
    },

    setSandboxContainer(projectId: string, loopName: string, containerName: string | null): void {
      setSandboxContainerStmt.run(containerName, projectId, loopName)
    },

    setPhaseAndResetError(projectId: string, loopName: string, phase: LoopRow['phase']): void {
      setPhaseAndResetErrorStmt.run(phase, projectId, loopName)
    },

    replaceSession(
      projectId: string,
      loopName: string,
      opts: { sessionId: string; phase: LoopRow['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }
    ): void {
      const runTxn = db.transaction(() => {
        replaceSessionStmt.run(
          opts.sessionId,
          opts.phase,
          opts.iteration ?? null,
          opts.auditCount ?? null,
          projectId,
          loopName
        )
        if (opts.lastAuditResult !== undefined && opts.lastAuditResult !== null && opts.lastAuditResult !== '') {
          setLastAuditResultStmt.run(opts.lastAuditResult, projectId, loopName)
        }
        if (opts.resetError) {
          resetErrorStmt.run(projectId, loopName)
        }
      })
      runTxn()
    },

    restart(projectId, loopName, opts) {
      restartStmt.run(
        opts.sessionId,
        opts.phase,
        opts.iteration,
        opts.auditCount,
        opts.sandbox ? 1 : 0,
        opts.sandboxContainer,
        opts.workspaceId,
        opts.startedAt,
        opts.currentSectionIndex,
        opts.totalSections,
        opts.finalAuditDone ? 1 : 0,
        projectId,
        loopName,
      )
    },

    setStatus(projectId: string, loopName: string, status: LoopRow['status']): void {
      setStatusStmt.run(status, projectId, loopName)
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

    setCurrentSectionIndex(projectId, loopName, index) {
      db.prepare(`UPDATE loops SET current_section_index = ? WHERE project_id = ? AND loop_name = ?`).run(index, projectId, loopName)
    },

    setTotalSections(projectId, loopName, total) {
      db.prepare(`UPDATE loops SET total_sections = ? WHERE project_id = ? AND loop_name = ?`).run(total, projectId, loopName)
    },

    setFinalAuditDone(projectId, loopName, done) {
      db.prepare(`UPDATE loops SET final_audit_done = ? WHERE project_id = ? AND loop_name = ?`).run(done ? 1 : 0, projectId, loopName)
    },
  }
}
