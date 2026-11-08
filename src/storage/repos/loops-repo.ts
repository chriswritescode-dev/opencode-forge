import type { Database } from 'bun:sqlite'
import type { Logger, LoopSandboxSettings } from '../../types'
import { readLoopSandboxSettings } from '../../sandbox/loop-settings'
import { findPartialMatch } from '../../utils/partial-match'
import {
  resolveSectionRunTarget,
  sectionRunKey,
  type SectionRunKind,
  type SectionRunTarget,
} from '../../loop/section-run'
import { createSectionRunsRepo } from './section-runs-repo'
import {
  handoffSchemaForRole,
  LOOP_HANDOFF_PHASES,
  LOOP_HANDOFF_ROLES,
  LOOP_HANDOFF_STATUSES,
  type LoopHandoffPhase,
  type LoopHandoffRecord,
  type LoopHandoffRecordFor,
  type LoopHandoffRole,
  type LoopHandoffStatus,
  type LoopHandoffWriteInput,
} from '../../loop/handoff'

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
  phase: 'coding' | 'auditing' | 'post_action'
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
  /** Index into the auditor model fallback chain; 0 is the preferred model. */
  auditorFallbackIndex?: number
  currentSectionIndex: number
  totalSections: number
  executionVariant: string | null
  auditorVariant: string | null
  /** Per-loop sandbox overrides; null when the loop uses config defaults. */
  sandboxSettings?: LoopSandboxSettings | null
  /** Exact commit sha the loop's worktree branched from; null for legacy rows. */
  baseCommit: string | null
  /** The other role's session for the current section, kept for reuse on the next same-section phase switch: the coder session while auditing, the audit session while coding. */
  standbySessionId: string | null
  sectionRunKind: SectionRunKind
  sectionId: string
  sectionRunKey: string
}

export interface LoopLargeFields {
  lastAuditResult: string | null
  postActionReport?: string | null
}

export interface LoopSidebarRow {
  loopName: string
  status: LoopRow['status']
  iteration: number
  maxIterations: number
  startedAt: number
  phase: LoopRow['phase']
  /** When the current phase began: the latest phase change of this run, else `startedAt`. */
  phaseStartedAt: number
  currentSectionIndex: number
  totalSections: number
}

export interface LoopsRepo {
  insert(row: LoopRow, large: LoopLargeFields): boolean
  /** In-place row restore (UPDATE; falls back to INSERT when row is missing). Preserves child rows (loop_transitions, section_plans) that would be cascade-deleted by `deleteState` + `insert`. */
  restore(row: LoopRow, large: LoopLargeFields): void
  get(projectId: string, loopName: string): LoopRow | null
  getLarge(projectId: string, loopName: string): LoopLargeFields | null
  getBySessionId(projectId: string, sessionId: string): LoopRow | null
  listByStatus(projectId: string, statuses: LoopRow['status'][]): LoopRow[]
  listAll(projectId: string): LoopRow[]
  listSidebarRows(projectId: string, limit: number): LoopSidebarRow[]
  updatePhase(projectId: string, loopName: string, phase: LoopRow['phase']): void
  updateIteration(projectId: string, loopName: string, iteration: number): void
  incrementError(projectId: string, loopName: string): number
  resetError(projectId: string, loopName: string): void
  /** Compare-and-swap advance of the auditor fallback index; returns the new index on success or null when the row is absent/non-running/index mismatch. */
  advanceAuditorFallbackIndex(projectId: string, loopName: string, fromIndex: number, toIndex: number): number | null
  /** Reset the auditor fallback index to 0; returns true when a running row was actually changed, false when it was already 0 / non-running / absent. */
  resetAuditorFallbackIndex(projectId: string, loopName: string): boolean
  setCurrentSessionId(projectId: string, loopName: string, sessionId: string): void
  /** Record (or clear, with null) the other role's session kept for same-section reuse. */
  setStandbySessionId(projectId: string, loopName: string, sessionId: string | null): void
  setWorkspaceId(projectId: string, loopName: string, workspaceId: string): void
  clearWorkspaceId(projectId: string, loopName: string): void
  setModelFailed(projectId: string, loopName: string, failed: boolean): void
  setLastAuditResult(projectId: string, loopName: string, text: string): void
  clearLastAuditResult(projectId: string, loopName: string): void
  setPostActionReport(projectId: string, loopName: string, text: string): void
  setSandboxContainer(projectId: string, loopName: string, containerName: string | null): void
  setPhaseAndResetError(projectId: string, loopName: string, phase: LoopRow['phase']): void
  setStatus(projectId: string, loopName: string, status: LoopRow['status']): void
  replaceSession(
    projectId: string,
    loopName: string,
    opts: {
      sessionId: string
      phase: LoopRow['phase']
      iteration?: number
      resetError?: boolean
      auditCount?: number
      lastAuditResult?: string | null
    }
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
      startedAt: number
      /** Primary auditor model used for the restarted prompt; persisted so later chain resolution agrees. */
      auditorModel: string | null
      auditorVariant?: string | null
      executionModel?: string | null
      executionVariant?: string | null
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
  /** Record the parsed handoff write as the section run's single pending handoff. */
  upsertPendingHandoff(input: LoopHandoffWriteInput & { projectId: string }): { record: LoopHandoffRecord; replaced: boolean }
  getPendingHandoff(projectId: string, loopName: string, sectionRunKey: string): LoopHandoffRecord | null
  /** Mark the session's pending handoff of `role` applied; a pending row for any other role stays pending. */
  applyPendingHandoff<R extends LoopHandoffRole>(
    projectId: string,
    loopName: string,
    sectionRunKey: string,
    sessionId: string,
    role: R,
  ): LoopHandoffRecordFor<R> | null
  /** Omitting `sectionRunKey` discards every pending handoff of the loop (cancel/restart path). */
  discardPendingHandoff(projectId: string, loopName: string, sectionRunKey?: string): void
  listHandoffs(projectId: string, loopName: string, limit?: number): LoopHandoffRecord[]
}

function mapRow(row: LoopRowRaw): LoopRow {
  return {
    projectId: row.project_id,
    loopName: row.loop_name,
    status: row.status as LoopRow['status'],
    currentSessionId: row.run_session_id,
    worktree: row.worktree === 1,
    worktreeDir: row.worktree_dir,
    worktreeBranch: row.worktree_branch,
    projectDir: row.project_dir,
    maxIterations: row.max_iterations,
    iteration: row.iteration,
    auditCount: row.audit_count,
    errorCount: row.error_count,
    phase: row.run_phase as LoopRow['phase'],
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
    currentSectionIndex: row.run_section_index,
    totalSections: row.total_sections,
    executionVariant: row.execution_variant,
    auditorVariant: row.auditor_variant,
    auditorFallbackIndex: row.auditor_fallback_index ?? 0,
    sandboxSettings: parseSandboxSettings(row.sandbox_settings),
    baseCommit: row.base_commit,
    standbySessionId: row.run_standby,
    sectionRunKind: row.section_run_kind as SectionRunKind,
    sectionId: row.section_run_section_id,
    sectionRunKey: sectionRunKey(row.section_run_kind as SectionRunKind, row.section_run_section_id),
  }
}

/** Parses a persisted `sandbox_settings` JSON column; malformed or empty values hydrate as null. */
function parseSandboxSettings(value: string | null): LoopSandboxSettings | null {
  if (!value) return null
  try {
    return readLoopSandboxSettings(JSON.parse(value)) ?? null
  } catch {
    return null
  }
}

/** Serializes sandbox overrides for a `sandbox_settings` JSON column; unset settings store as null. */
function serializeSandboxSettings(settings: LoopSandboxSettings | null | undefined): string | null {
  return settings ? JSON.stringify(settings) : null
}

interface LoopRowRaw {
  project_id: string
  loop_name: string
  status: string
  run_session_id: string
  worktree: number
  worktree_dir: string
  worktree_branch: string | null
  project_dir: string
  max_iterations: number
  iteration: number
  audit_count: number
  error_count: number
  run_phase: string
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
  run_section_index: number
  total_sections: number
  execution_variant: string | null
  auditor_variant: string | null
  auditor_fallback_index: number
  sandbox_settings: string | null
  base_commit: string | null
  run_standby: string | null
  section_run_kind: string
  section_run_section_id: string
}

const LOOP_COLUMNS = `project_id, loop_name, status, worktree, worktree_dir,
  worktree_branch, project_dir, max_iterations, iteration, audit_count,
  error_count, execution_model, auditor_model,
  model_failed, sandbox, sandbox_container, started_at, completed_at,
  termination_reason, completion_summary, workspace_id, host_session_id,
  total_sections,
  execution_variant, auditor_variant, auditor_fallback_index, sandbox_settings, base_commit`

const LOOP_COLUMN_PLACEHOLDERS = LOOP_COLUMNS.split(',').map(() => '?').join(', ')

const LOOP_SELECT_COLUMNS = `l.project_id, l.loop_name, l.status,
  r.session_id AS run_session_id,
  l.worktree, l.worktree_dir, l.worktree_branch, l.project_dir,
  l.max_iterations, l.iteration, l.audit_count, l.error_count,
  r.phase AS run_phase,
  l.execution_model, l.auditor_model, l.model_failed, l.sandbox, l.sandbox_container,
  l.started_at, l.completed_at, l.termination_reason, l.completion_summary,
  l.workspace_id, l.host_session_id,
  r.section_index AS run_section_index,
  l.total_sections,
  l.execution_variant, l.auditor_variant, l.auditor_fallback_index, l.sandbox_settings, l.base_commit,
  r.standby_session_id AS run_standby,
  r.kind AS section_run_kind,
  r.section_id AS section_run_section_id`

const LOOP_ACTIVE_RUN_JOIN = `LEFT JOIN section_runs r
  ON r.project_id = l.project_id AND r.loop_name = l.loop_name AND r.status = 'active'`

const HANDOFF_COLUMNS = `id, project_id, loop_name, session_id, role, phase, section_index, section_run_key,
  iteration, payload, status, created_at, resolved_at`

interface LoopHandoffRowRaw {
  id: number
  project_id: string
  loop_name: string
  session_id: string
  role: string
  phase: string
  section_index: number | null
  section_run_key: string
  iteration: number
  payload: string
  status: string
  created_at: number
  resolved_at: number | null
}

function parseHandoffRole(value: string): LoopHandoffRole | null {
  return LOOP_HANDOFF_ROLES.find((role) => role === value) ?? null
}

function parseHandoffPhase(value: string): LoopHandoffPhase | null {
  return LOOP_HANDOFF_PHASES.find((phase) => phase === value) ?? null
}

function parseHandoffStatus(value: string): LoopHandoffStatus | null {
  return LOOP_HANDOFF_STATUSES.find((status) => status === value) ?? null
}

function mapHandoffRow(raw: LoopHandoffRowRaw, logger?: Logger): LoopHandoffRecord | null {
  const role = parseHandoffRole(raw.role)
  if (!role) {
    logger?.error(`LoopsRepo: invalid handoff role "${raw.role}" for handoff ${String(raw.id)}`)
    return null
  }
  const phase = parseHandoffPhase(raw.phase)
  if (!phase) {
    logger?.error(`LoopsRepo: invalid handoff phase "${raw.phase}" for handoff ${String(raw.id)}`)
    return null
  }
  const status = parseHandoffStatus(raw.status)
  if (!status) {
    logger?.error(`LoopsRepo: invalid handoff status "${raw.status}" for handoff ${String(raw.id)}`)
    return null
  }
  let parsedPayload: unknown
  try {
    parsedPayload = JSON.parse(raw.payload)
  } catch (err) {
    logger?.error(`LoopsRepo: invalid handoff payload JSON for handoff ${String(raw.id)}`, err)
    return null
  }
  const base = {
    id: raw.id,
    projectId: raw.project_id,
    loopName: raw.loop_name,
    sessionId: raw.session_id,
    phase,
    sectionIndex: raw.section_index,
    sectionRunKey: raw.section_run_key,
    iteration: raw.iteration,
    status,
    createdAt: raw.created_at,
    resolvedAt: raw.resolved_at,
  }
  const parsed = handoffSchemaForRole(role).safeParse(parsedPayload)
  if (!parsed.success) {
    const roleLabel = role === 'post_action' ? 'post-action' : role
    logger?.error(`LoopsRepo: invalid ${roleLabel} handoff payload for handoff ${String(raw.id)}`, parsed.error)
    return null
  }
  return { ...base, role, payload: parsed.data } as LoopHandoffRecord
}

function handoffRecordForRole<R extends LoopHandoffRole>(
  record: LoopHandoffRecord,
  role: R,
): LoopHandoffRecordFor<R> | null {
  return record.role === role ? record as LoopHandoffRecordFor<R> : null
}

export function createLoopsRepo(db: Database, logger?: Logger): LoopsRepo {
  const sectionRuns = createSectionRunsRepo(db)

  const insertStmt = db.prepare(`
    INSERT INTO loops (${LOOP_COLUMNS})
    VALUES (${LOOP_COLUMN_PLACEHOLDERS})
  `)

  const upsertLargeStmt = db.prepare(`
    INSERT INTO loop_large_fields (project_id, loop_name, last_audit_result, post_action_report)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (project_id, loop_name) DO UPDATE SET
      last_audit_result = excluded.last_audit_result,
      post_action_report = COALESCE(excluded.post_action_report, loop_large_fields.post_action_report)
  `)

  const getStmt = db.prepare(`
    SELECT ${LOOP_SELECT_COLUMNS}
    FROM loops l
    ${LOOP_ACTIVE_RUN_JOIN}
    WHERE l.project_id = ? AND l.loop_name = ?
  `)

  const getLargeStmt = db.prepare(`
    SELECT last_audit_result, post_action_report
    FROM loop_large_fields
    WHERE project_id = ? AND loop_name = ?
  `)

  const getBySessionIdStmt = db.prepare(`
    SELECT ${LOOP_SELECT_COLUMNS}
    FROM loops l
    ${LOOP_ACTIVE_RUN_JOIN}
    WHERE l.project_id = ? AND r.session_id = ? AND l.status = 'running'
  `)

  const listByStatusBase = `
    SELECT ${LOOP_SELECT_COLUMNS}
    FROM loops l
    ${LOOP_ACTIVE_RUN_JOIN}
    WHERE l.project_id = ? AND l.status IN
  `

  /** Prepared on first use: it reads loop_transitions, which databases opened without migrations may lack. */
  const listSidebarRowsSql = `
    SELECT l.loop_name, l.status, l.iteration, l.max_iterations, l.started_at,
           r.phase AS run_phase, r.section_index AS run_section_index, l.total_sections,
           (
             SELECT MAX(t.created_at)
             FROM loop_transitions t
             WHERE t.project_id = l.project_id AND t.loop_name = l.loop_name
               AND t.event_type != 'restart' AND t.to_phase IS NOT NULL AND t.created_at >= l.started_at
           ) AS phase_changed_at
    FROM loops l
    ${LOOP_ACTIVE_RUN_JOIN}
    WHERE l.project_id = ?
    ORDER BY l.status = 'running' DESC, l.started_at DESC
    LIMIT ?
  `
  let listSidebarRowsStmt: ReturnType<Database['prepare']> | null = null

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

  const advanceAuditorFallbackIndexStmt = db.prepare(`
    UPDATE loops SET auditor_fallback_index = ?
    WHERE project_id = ? AND loop_name = ? AND status = 'running' AND auditor_fallback_index = ?
    RETURNING auditor_fallback_index
  `)

  const resetAuditorFallbackIndexStmt = db.prepare(`
    UPDATE loops SET auditor_fallback_index = 0
    WHERE project_id = ? AND loop_name = ? AND status = 'running' AND auditor_fallback_index != 0
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

  const setPostActionReportStmt = db.prepare(`
    UPDATE loop_large_fields SET post_action_report = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const clearPostActionReportStmt = db.prepare(`
    UPDATE loop_large_fields SET post_action_report = NULL
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
    UPDATE loops SET error_count = 0, model_failed = 0
    WHERE project_id = ? AND loop_name = ?
  `)

  const replaceSessionStmt = db.prepare(`
    UPDATE loops SET
      iteration = COALESCE(?, iteration),
      audit_count = COALESCE(?, audit_count)
    WHERE project_id = ? AND loop_name = ?
  `)

  const restartStmt = db.prepare(`
    UPDATE loops SET
      status = 'running',
      iteration = ?,
      audit_count = ?,
      error_count = 0,
      model_failed = 0,
      auditor_fallback_index = 0,
      sandbox = ?,
      sandbox_container = ?,
      workspace_id = ?,
      auditor_model = ?,
      auditor_variant = CASE WHEN ? = 1 THEN ? ELSE auditor_variant END,
      execution_model = CASE WHEN ? = 1 THEN ? ELSE execution_model END,
      execution_variant = CASE WHEN ? = 1 THEN ? ELSE execution_variant END,
      started_at = ?,
      completed_at = NULL,
      termination_reason = NULL,
      completion_summary = NULL,
      total_sections = ?
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

  // In-place row restore: UPDATE all loop columns by primary key. Preserves
  // child rows (loop_transitions, section_plans) by avoiding deleteState +
  // insert, which would trigger FK ON DELETE CASCADE. Falls back to INSERT
  // when no row matches (defensive against concurrent external deletes).
  const restoreStmt = db.prepare(`
    UPDATE loops SET
      status = ?, worktree = ?, worktree_dir = ?, worktree_branch = ?,
      project_dir = ?, max_iterations = ?, iteration = ?, audit_count = ?, error_count = ?,
      execution_model = ?, auditor_model = ?, model_failed = ?, sandbox = ?,
      sandbox_container = ?, started_at = ?, completed_at = ?, termination_reason = ?,
      completion_summary = ?, workspace_id = ?, host_session_id = ?,
      total_sections = ?,
      execution_variant = ?, auditor_variant = ?, auditor_fallback_index = ?,
      sandbox_settings = ?, base_commit = ?
    WHERE project_id = ? AND loop_name = ?
  `)

  const deleteStmt = db.prepare(`
    DELETE FROM loops WHERE project_id = ? AND loop_name = ?
  `)

  const deleteLargeStmt = db.prepare(`
    DELETE FROM loop_large_fields WHERE project_id = ? AND loop_name = ?
  `)

  const totalSectionsStmt = db.prepare(`
    SELECT total_sections FROM loops WHERE project_id = ? AND loop_name = ?
  `)

  const updatePendingHandoffStmt = db.prepare(`
    UPDATE loop_handoffs
    SET session_id = ?, role = ?, phase = ?, section_index = ?, iteration = ?, payload = ?, created_at = ?
    WHERE project_id = ? AND loop_name = ? AND section_run_key = ? AND status = 'pending'
  `)

  const insertPendingHandoffStmt = db.prepare(`
    INSERT INTO loop_handoffs (
      project_id, loop_name, session_id, role, phase, section_index, iteration, payload, status, created_at, resolved_at, section_run_key
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)
  `)

  const getPendingHandoffStmt = db.prepare(`
    SELECT ${HANDOFF_COLUMNS}
    FROM loop_handoffs
    WHERE project_id = ? AND loop_name = ? AND section_run_key = ? AND status = 'pending'
    ORDER BY id DESC
    LIMIT 1
  `)

  const applyPendingHandoffStmt = db.prepare(`
    UPDATE loop_handoffs
    SET status = 'applied', resolved_at = ?
    WHERE project_id = ? AND loop_name = ? AND section_run_key = ? AND session_id = ? AND role = ? AND status = 'pending'
    RETURNING ${HANDOFF_COLUMNS}
  `)

  const discardPendingHandoffStmt = db.prepare(`
    UPDATE loop_handoffs
    SET status = 'discarded', resolved_at = ?
    WHERE project_id = ? AND loop_name = ? AND section_run_key = ? AND status = 'pending'
  `)

  const discardLoopPendingHandoffsStmt = db.prepare(`
    UPDATE loop_handoffs
    SET status = 'discarded', resolved_at = ?
    WHERE project_id = ? AND loop_name = ? AND status = 'pending'
  `)

  const listHandoffsStmt = db.prepare(`
    SELECT ${HANDOFF_COLUMNS}
    FROM loop_handoffs
    WHERE project_id = ? AND loop_name = ?
    ORDER BY id ASC
    LIMIT ?
  `)

  /**
   * Positional bind values shared by the INSERT and restore-UPDATE statements
   * (every loops column except the project_id/loop_name key; the run-scoped
   * session, phase, section index and standby session live on section_runs).
   * Adding a loops column requires updating only this list plus the two SQL statements.
   */
  function loopRowValues(row: LoopRow): (string | number | null)[] {
    return [
      row.status,
      row.worktree ? 1 : 0,
      row.worktreeDir,
      row.worktreeBranch,
      row.projectDir,
      row.maxIterations,
      row.iteration,
      row.auditCount,
      row.errorCount,
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
      row.totalSections ?? 0,
      row.executionVariant ?? null,
      row.auditorVariant ?? null,
      row.auditorFallbackIndex ?? 0,
      serializeSandboxSettings(row.sandboxSettings),
      row.baseCommit ?? null,
    ]
  }

  function totalSectionsOf(projectId: string, loopName: string): number {
    const row = totalSectionsStmt.get(projectId, loopName) as { total_sections: number } | null
    return row?.total_sections ?? 0
  }

  function resolveTarget(
    projectId: string,
    loopName: string,
    phase: LoopRow['phase'],
    totalSections: number,
    currentSectionIndex: number,
  ): SectionRunTarget {
    return resolveSectionRunTarget(
      { phase, totalSections, currentSectionIndex },
      (index) => sectionRuns.sectionIdAt(projectId, loopName, index),
    )
  }

  function applyPhaseChange(projectId: string, loopName: string, phase: LoopRow['phase']): void {
    const active = sectionRuns.getActive(projectId, loopName)
    if (active && (active.kind === 'post_action') !== (phase === 'post_action')) {
      const totalSections = totalSectionsOf(projectId, loopName)
      sectionRuns.moveActive(projectId, loopName, resolveTarget(projectId, loopName, phase, totalSections, active.sectionIndex))
    }
    sectionRuns.updateActive(projectId, loopName, { phase })
  }

  return {
    insert(row: LoopRow, large: LoopLargeFields): boolean {
      const runInsert = db.transaction(() => {
        const result = insertStmt.run(
          row.projectId,
          row.loopName,
          ...loopRowValues(row),
        ) as unknown as { changes: number }
        if (result.changes === 0) {
          return false
        }
        upsertLargeStmt.run(row.projectId, row.loopName, large.lastAuditResult, large.postActionReport ?? null)
        sectionRuns.activate(
          row.projectId,
          row.loopName,
          resolveTarget(row.projectId, row.loopName, row.phase, row.totalSections ?? 0, row.currentSectionIndex ?? 0),
          {
            sessionId: row.currentSessionId,
            phase: row.phase,
            standbySessionId: row.standbySessionId ?? null,
          },
          row.startedAt,
        )
        return true
      })
      return runInsert()
    },

    restore(row: LoopRow, large: LoopLargeFields): void {
      const runRestore = db.transaction(() => {
        const result = restoreStmt.run(
          ...loopRowValues(row),
          row.projectId,
          row.loopName,
        ) as unknown as { changes: number }
        if (result.changes === 0) {
          // Row was concurrently deleted; fall back to INSERT so callers can
          // restore a loop row even when an external delete raced the rollback.
          insertStmt.run(
            row.projectId,
            row.loopName,
            ...loopRowValues(row),
          )
        }
        upsertLargeStmt.run(row.projectId, row.loopName, large.lastAuditResult, large.postActionReport ?? null)
        sectionRuns.activate(
          row.projectId,
          row.loopName,
          resolveTarget(row.projectId, row.loopName, row.phase, row.totalSections ?? 0, row.currentSectionIndex ?? 0),
          {
            sessionId: row.currentSessionId,
            phase: row.phase,
            standbySessionId: row.standbySessionId ?? null,
          },
          row.startedAt,
        )
      })
      runRestore()
    },

    get(projectId: string, loopName: string): LoopRow | null {
      const row = getStmt.get(projectId, loopName) as LoopRowRaw | null
      return row ? mapRow(row) : null
    },

    getLarge(projectId: string, loopName: string): LoopLargeFields | null {
      const row = getLargeStmt.get(projectId, loopName) as { last_audit_result: string | null; post_action_report: string | null } | null
      if (!row) return null
      return {
        lastAuditResult: row.last_audit_result,
        postActionReport: row.post_action_report,
      }
    },

    getBySessionId(projectId: string, sessionId: string): LoopRow | null {
      const row = getBySessionIdStmt.get(projectId, sessionId) as LoopRowRaw | null
      return row ? mapRow(row) : null
    },

    listByStatus(projectId: string, statuses: LoopRow['status'][]): LoopRow[] {
      if (statuses.length === 0) return []
      const placeholders = statuses.map(() => '?').join(',')
      const sql = `${listByStatusBase} (${placeholders}) ORDER BY l.started_at DESC`
      const stmt = db.prepare(sql)
      const rows = stmt.all(projectId, ...statuses) as LoopRowRaw[]
      return rows.map(mapRow)
    },

    listAll(projectId: string): LoopRow[] {
      const allStatuses: LoopRow['status'][] = ['running', 'completed', 'cancelled', 'errored', 'stalled']
      return this.listByStatus(projectId, allStatuses)
    },

    listSidebarRows(projectId: string, limit: number): LoopSidebarRow[] {
      listSidebarRowsStmt ??= db.prepare(listSidebarRowsSql)
      const rows = listSidebarRowsStmt.all(projectId, limit) as Array<{
        loop_name: string
        status: string
        iteration: number
        max_iterations: number
        started_at: number
        run_phase: string
        run_section_index: number
        total_sections: number
        phase_changed_at: number | null
      }>
      return rows.map((row) => ({
        loopName: row.loop_name,
        status: row.status as LoopRow['status'],
        iteration: row.iteration,
        maxIterations: row.max_iterations,
        startedAt: row.started_at,
        phase: row.run_phase as LoopRow['phase'],
        phaseStartedAt: row.phase_changed_at ?? row.started_at,
        currentSectionIndex: row.run_section_index,
        totalSections: row.total_sections,
      }))
    },

    updatePhase(projectId: string, loopName: string, phase: LoopRow['phase']): void {
      const runTxn = db.transaction(() => {
        applyPhaseChange(projectId, loopName, phase)
      })
      runTxn()
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

    advanceAuditorFallbackIndex(projectId: string, loopName: string, fromIndex: number, toIndex: number): number | null {
      const result = advanceAuditorFallbackIndexStmt.get(toIndex, projectId, loopName, fromIndex) as { auditor_fallback_index: number } | null
      return result?.auditor_fallback_index ?? null
    },

    resetAuditorFallbackIndex(projectId: string, loopName: string): boolean {
      const result = resetAuditorFallbackIndexStmt.run(projectId, loopName) as unknown as { changes: number }
      return result.changes > 0
    },

    setCurrentSessionId(projectId: string, loopName: string, sessionId: string): void {
      const runTxn = db.transaction(() => {
        sectionRuns.updateActive(projectId, loopName, { sessionId })
      })
      runTxn()
    },

    setStandbySessionId(projectId: string, loopName: string, sessionId: string | null): void {
      const runTxn = db.transaction(() => {
        sectionRuns.updateActive(projectId, loopName, { standbySessionId: sessionId })
      })
      runTxn()
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

    setPostActionReport(projectId: string, loopName: string, text: string): void {
      if (text === '') return
      setPostActionReportStmt.run(text, projectId, loopName)
    },

    setSandboxContainer(projectId: string, loopName: string, containerName: string | null): void {
      setSandboxContainerStmt.run(containerName, projectId, loopName)
    },

    setPhaseAndResetError(projectId: string, loopName: string, phase: LoopRow['phase']): void {
      const runTxn = db.transaction(() => {
        setPhaseAndResetErrorStmt.run(projectId, loopName)
        applyPhaseChange(projectId, loopName, phase)
      })
      runTxn()
    },

    replaceSession(
      projectId: string,
      loopName: string,
      opts: { sessionId: string; phase: LoopRow['phase']; iteration?: number; resetError?: boolean; auditCount?: number; lastAuditResult?: string | null }
    ): void {
      const runTxn = db.transaction(() => {
        replaceSessionStmt.run(
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
        applyPhaseChange(projectId, loopName, opts.phase)
        sectionRuns.updateActive(projectId, loopName, { sessionId: opts.sessionId, phase: opts.phase })
      })
      runTxn()
    },

    restart(projectId, loopName, opts) {
      const runTxn = db.transaction(() => {
        // Clear the stale post-action report alongside completion_summary: a restarted
        // loop will produce a fresh post-action run (or none at all).
        clearPostActionReportStmt.run(projectId, loopName)
        const setsAuditorVariant = opts.auditorVariant !== undefined ? 1 : 0
        const setsExecutionModel = opts.executionModel !== undefined ? 1 : 0
        const setsExecutionVariant = opts.executionVariant !== undefined ? 1 : 0
        restartStmt.run(
          opts.iteration,
          opts.auditCount,
          opts.sandbox ? 1 : 0,
          opts.sandboxContainer,
          opts.workspaceId,
          opts.auditorModel,
          setsAuditorVariant,
          setsAuditorVariant ? (opts.auditorVariant ?? null) : null,
          setsExecutionModel,
          setsExecutionModel ? (opts.executionModel ?? null) : null,
          setsExecutionVariant,
          setsExecutionVariant ? (opts.executionVariant ?? null) : null,
          opts.startedAt,
          opts.totalSections,
          projectId,
          loopName,
        )
        sectionRuns.activate(
          projectId,
          loopName,
          resolveTarget(projectId, loopName, opts.phase, opts.totalSections, opts.currentSectionIndex),
          {
            sessionId: opts.sessionId,
            phase: opts.phase,
            standbySessionId: null,
          },
          opts.startedAt,
        )
      })
      runTxn()
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
      const runTxn = db.transaction(() => {
        terminateStmt.run(opts.status, opts.completedAt, opts.reason, opts.summary ?? null, projectId, loopName)
        sectionRuns.updateActive(projectId, loopName, { standbySessionId: null })
      })
      runTxn()
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
      const runTxn = db.transaction(() => {
        const active = sectionRuns.getActive(projectId, loopName)
        if (active) {
          sectionRuns.moveActive(
            projectId,
            loopName,
            resolveTarget(projectId, loopName, active.phase, totalSectionsOf(projectId, loopName), index),
          )
        }
      })
      runTxn()
    },

    setTotalSections(projectId, loopName, total) {
      const runTxn = db.transaction(() => {
        db.prepare(`UPDATE loops SET total_sections = ? WHERE project_id = ? AND loop_name = ?`).run(total, projectId, loopName)
        if (total > 0) {
          const active = sectionRuns.getActive(projectId, loopName)
          if (active && active.sectionIndex >= total) {
            sectionRuns.moveActive(
              projectId,
              loopName,
              resolveTarget(projectId, loopName, active.phase, total, total - 1),
            )
          }
        }
      })
      runTxn()
    },

    upsertPendingHandoff(input: LoopHandoffWriteInput & { projectId: string }): { record: LoopHandoffRecord; replaced: boolean } {
      const payload = JSON.stringify(input.payload)
      const runUpsert = db.transaction(() => {
        const now = Date.now()
        const updated = updatePendingHandoffStmt.run(
          input.sessionId,
          input.role,
          input.phase,
          input.sectionIndex,
          input.iteration,
          payload,
          now,
          input.projectId,
          input.loopName,
          input.sectionRunKey,
        ) as unknown as { changes: number }
        const replaced = updated.changes > 0
        if (!replaced) {
          insertPendingHandoffStmt.run(
            input.projectId,
            input.loopName,
            input.sessionId,
            input.role,
            input.phase,
            input.sectionIndex,
            input.iteration,
            payload,
            now,
            input.sectionRunKey,
          )
        }
        const row = getPendingHandoffStmt.get(input.projectId, input.loopName, input.sectionRunKey) as LoopHandoffRowRaw | undefined
        const record = row ? mapHandoffRow(row, logger) : null
        if (!record) {
          throw new Error(`LoopsRepo: failed to read back pending handoff for ${input.loopName}`)
        }
        return { record, replaced }
      })
      return runUpsert()
    },

    getPendingHandoff(projectId: string, loopName: string, sectionRunKey: string): LoopHandoffRecord | null {
      const row = getPendingHandoffStmt.get(projectId, loopName, sectionRunKey) as LoopHandoffRowRaw | undefined
      return row ? mapHandoffRow(row, logger) : null
    },

    applyPendingHandoff<R extends LoopHandoffRole>(
      projectId: string,
      loopName: string,
      sectionRunKey: string,
      sessionId: string,
      role: R,
    ): LoopHandoffRecordFor<R> | null {
      const row = applyPendingHandoffStmt.get(Date.now(), projectId, loopName, sectionRunKey, sessionId, role) as LoopHandoffRowRaw | undefined
      const record = row ? mapHandoffRow(row, logger) : null
      return record ? handoffRecordForRole(record, role) : null
    },

    discardPendingHandoff(projectId: string, loopName: string, sectionRunKey?: string): void {
      if (sectionRunKey === undefined) {
        discardLoopPendingHandoffsStmt.run(Date.now(), projectId, loopName)
      } else {
        discardPendingHandoffStmt.run(Date.now(), projectId, loopName, sectionRunKey)
      }
    },

    listHandoffs(projectId: string, loopName: string, limit?: number): LoopHandoffRecord[] {
      const rows = listHandoffsStmt.all(projectId, loopName, limit ?? -1) as LoopHandoffRowRaw[]
      const records: LoopHandoffRecord[] = []
      for (const row of rows) {
        const record = mapHandoffRow(row, logger)
        if (record) records.push(record)
      }
      return records
    },

  }
}
