import type { Database } from 'bun:sqlite'
import { sectionRunKey, splitRunKey, type SectionRunKind, type SectionRunTarget } from '../../loop/section-run'
import { hasTable } from '../database'

type SectionRunPhase = 'coding' | 'auditing' | 'post_action'
type SectionRunStatus = 'active' | 'finished'

export interface SectionRunRow {
  projectId: string
  loopName: string
  kind: SectionRunKind
  sectionId: string
  sectionIndex: number
  phase: SectionRunPhase
  sessionId: string
  standbySessionId: string | null
  status: SectionRunStatus
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  sectionRunKey: string
  laneDir: string | null
  laneBranch: string | null
  laneBaseCommit: string | null
  errorCount: number
  modelFailed: boolean
  auditorFallbackIndex: number
}

export interface SectionRunActivateFields {
  sessionId: string
  phase: SectionRunPhase
  standbySessionId: string | null
  laneDir?: string | null
  laneBranch?: string | null
  laneBaseCommit?: string | null
}

export interface SectionRunUpdatePatch {
  sessionId?: string
  phase?: SectionRunPhase
  standbySessionId?: string | null
  sectionIndex?: number
  laneDir?: string | null
  laneBranch?: string | null
  laneBaseCommit?: string | null
  errorCount?: number
  modelFailed?: boolean
  auditorFallbackIndex?: number
}

export interface SectionRunActivateOptions {
  /** Finish every other active run of the loop (serial loop advance). */
  exclusive: boolean
  now?: number
}

export interface SectionRunsRepo {
  get(projectId: string, loopName: string, runKey: string): SectionRunRow | null
  /** The active run that owns `sessionId`, across every loop of the project. */
  getBySession(projectId: string, sessionId: string): SectionRunRow | null
  listActive(projectId: string, loopName: string): SectionRunRow[]
  listForLoop(projectId: string, loopName: string): SectionRunRow[]
  activate(
    projectId: string,
    loopName: string,
    target: SectionRunTarget,
    fields: SectionRunActivateFields,
    opts: SectionRunActivateOptions,
  ): void
  update(
    projectId: string,
    loopName: string,
    runKey: string,
    patch: SectionRunUpdatePatch,
    now?: number,
  ): void
  incrementError(projectId: string, loopName: string, runKey: string): number
  /** Compare-and-swap advance of the auditor fallback index by one; false when the run is absent, inactive or the index moved. */
  advanceAuditorFallbackIndex(projectId: string, loopName: string, runKey: string, expected: number): boolean
  finish(projectId: string, loopName: string, runKey: string, now?: number): void
  sectionIdAt(projectId: string, loopName: string, index: number): string | null
}

const RUN_COLUMNS = `project_id, loop_name, kind, section_id, section_index, phase, session_id,
  standby_session_id, status, started_at, updated_at, finished_at,
  lane_dir, lane_branch, lane_base_commit, error_count, model_failed, auditor_fallback_index`

function mapRow(row: Record<string, unknown>): SectionRunRow {
  const kind = row.kind as SectionRunKind
  const sectionId = row.section_id as string
  return {
    projectId: row.project_id as string,
    loopName: row.loop_name as string,
    kind,
    sectionId,
    sectionIndex: row.section_index as number,
    phase: row.phase as SectionRunPhase,
    sessionId: row.session_id as string,
    standbySessionId: (row.standby_session_id as string | null) ?? null,
    status: row.status as SectionRunStatus,
    startedAt: row.started_at as number,
    updatedAt: row.updated_at as number,
    finishedAt: (row.finished_at as number | null) ?? null,
    sectionRunKey: sectionRunKey(kind, sectionId),
    laneDir: (row.lane_dir as string | null) ?? null,
    laneBranch: (row.lane_branch as string | null) ?? null,
    laneBaseCommit: (row.lane_base_commit as string | null) ?? null,
    errorCount: row.error_count as number,
    modelFailed: row.model_failed === 1,
    auditorFallbackIndex: row.auditor_fallback_index as number,
  }
}

export function createSectionRunsRepo(db: Database): SectionRunsRepo {
  const stmtGet = db.prepare(`
    SELECT ${RUN_COLUMNS}
    FROM section_runs
    WHERE project_id = ? AND loop_name = ? AND kind = ? AND section_id = ?
  `)

  const stmtGetBySession = db.prepare(`
    SELECT ${RUN_COLUMNS}
    FROM section_runs
    WHERE project_id = ? AND session_id = ? AND status = 'active'
    ORDER BY started_at DESC, kind ASC, section_id ASC
    LIMIT 1
  `)

  const stmtListActive = db.prepare(`
    SELECT ${RUN_COLUMNS}
    FROM section_runs
    WHERE project_id = ? AND loop_name = ? AND status = 'active'
    ORDER BY section_index ASC, kind ASC, section_id ASC
  `)

  const stmtList = db.prepare(`
    SELECT ${RUN_COLUMNS}
    FROM section_runs
    WHERE project_id = ? AND loop_name = ?
    ORDER BY started_at ASC, kind ASC, section_id ASC
  `)

  const stmtFinishOthers = db.prepare(`
    UPDATE section_runs
    SET status = 'finished', finished_at = ?, updated_at = ?
    WHERE project_id = ? AND loop_name = ? AND status = 'active' AND NOT (kind = ? AND section_id = ?)
  `)

  const stmtUpsert = db.prepare(`
    INSERT INTO section_runs (
      project_id, loop_name, kind, section_id, section_index, phase, session_id,
      standby_session_id, status, started_at, updated_at, finished_at,
      lane_dir, lane_branch, lane_base_commit, error_count, model_failed, auditor_fallback_index
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, 0, 0, 0)
    ON CONFLICT (project_id, loop_name, kind, section_id) DO UPDATE SET
      section_index = excluded.section_index,
      phase = excluded.phase,
      session_id = excluded.session_id,
      standby_session_id = excluded.standby_session_id,
      status = 'active',
      updated_at = excluded.updated_at,
      finished_at = NULL,
      lane_dir = COALESCE(excluded.lane_dir, section_runs.lane_dir),
      lane_branch = COALESCE(excluded.lane_branch, section_runs.lane_branch),
      lane_base_commit = COALESCE(excluded.lane_base_commit, section_runs.lane_base_commit)
  `)

  const activateTx = db.transaction((...args: unknown[]) => {
    const [projectId, loopName, target, fields, opts] = args as [
      string,
      string,
      SectionRunTarget,
      SectionRunActivateFields,
      SectionRunActivateOptions,
    ]
    const at = opts.now ?? Date.now()
    if (opts.exclusive) {
      stmtFinishOthers.run(at, at, projectId, loopName, target.kind, target.sectionId)
    }
    stmtUpsert.run(
      projectId,
      loopName,
      target.kind,
      target.sectionId,
      target.sectionIndex,
      fields.phase,
      fields.sessionId,
      fields.standbySessionId,
      at,
      at,
      fields.laneDir ?? null,
      fields.laneBranch ?? null,
      fields.laneBaseCommit ?? null,
    )
  })

  function get(projectId: string, loopName: string, runKey: string): SectionRunRow | null {
    const target = splitRunKey(runKey)
    const row = stmtGet.get(projectId, loopName, target.kind, target.sectionId) as Record<string, unknown> | null
    return row ? mapRow(row) : null
  }

  function getBySession(projectId: string, sessionId: string): SectionRunRow | null {
    const row = stmtGetBySession.get(projectId, sessionId) as Record<string, unknown> | null
    return row ? mapRow(row) : null
  }

  function listActive(projectId: string, loopName: string): SectionRunRow[] {
    const rows = stmtListActive.all(projectId, loopName) as Array<Record<string, unknown>>
    return rows.map(mapRow)
  }

  function activate(
    projectId: string,
    loopName: string,
    target: SectionRunTarget,
    fields: SectionRunActivateFields,
    opts: SectionRunActivateOptions,
  ): void {
    activateTx(projectId, loopName, target, fields, opts)
  }

  function update(
    projectId: string,
    loopName: string,
    runKey: string,
    patch: SectionRunUpdatePatch,
    now?: number,
  ): void {
    const assignments: string[] = []
    const params: Array<string | number | null> = []
    if (patch.sessionId !== undefined) {
      assignments.push('session_id = ?')
      params.push(patch.sessionId)
    }
    if (patch.phase !== undefined) {
      assignments.push('phase = ?')
      params.push(patch.phase)
    }
    if ('standbySessionId' in patch) {
      assignments.push('standby_session_id = ?')
      params.push(patch.standbySessionId ?? null)
    }
    if (patch.sectionIndex !== undefined) {
      assignments.push('section_index = ?')
      params.push(patch.sectionIndex)
    }
    if ('laneDir' in patch) {
      assignments.push('lane_dir = ?')
      params.push(patch.laneDir ?? null)
    }
    if ('laneBranch' in patch) {
      assignments.push('lane_branch = ?')
      params.push(patch.laneBranch ?? null)
    }
    if ('laneBaseCommit' in patch) {
      assignments.push('lane_base_commit = ?')
      params.push(patch.laneBaseCommit ?? null)
    }
    if (patch.errorCount !== undefined) {
      assignments.push('error_count = ?')
      params.push(patch.errorCount)
    }
    if (patch.modelFailed !== undefined) {
      assignments.push('model_failed = ?')
      params.push(patch.modelFailed ? 1 : 0)
    }
    if (patch.auditorFallbackIndex !== undefined) {
      assignments.push('auditor_fallback_index = ?')
      params.push(patch.auditorFallbackIndex)
    }
    if (assignments.length === 0) return
    assignments.push('updated_at = ?')
    params.push(now ?? Date.now())
    const target = splitRunKey(runKey)
    db.prepare(`
      UPDATE section_runs
      SET ${assignments.join(', ')}
      WHERE project_id = ? AND loop_name = ? AND kind = ? AND section_id = ?
    `).run(...params, projectId, loopName, target.kind, target.sectionId)
  }

  function incrementError(projectId: string, loopName: string, runKey: string): number {
    const target = splitRunKey(runKey)
    const row = db.prepare(`
      UPDATE section_runs
      SET error_count = error_count + 1, updated_at = ?
      WHERE project_id = ? AND loop_name = ? AND kind = ? AND section_id = ?
      RETURNING error_count
    `).get(Date.now(), projectId, loopName, target.kind, target.sectionId) as { error_count: number } | null
    return row?.error_count ?? 0
  }

  function advanceAuditorFallbackIndex(
    projectId: string,
    loopName: string,
    runKey: string,
    expected: number,
  ): boolean {
    const target = splitRunKey(runKey)
    const row = db.prepare(`
      UPDATE section_runs
      SET auditor_fallback_index = auditor_fallback_index + 1, updated_at = ?
      WHERE project_id = ? AND loop_name = ? AND kind = ? AND section_id = ?
        AND status = 'active' AND auditor_fallback_index = ?
      RETURNING auditor_fallback_index
    `).get(Date.now(), projectId, loopName, target.kind, target.sectionId, expected) as
      | { auditor_fallback_index: number }
      | null
    return row != null
  }

  function finish(projectId: string, loopName: string, runKey: string, now?: number): void {
    const target = splitRunKey(runKey)
    const at = now ?? Date.now()
    db.prepare(`
      UPDATE section_runs
      SET status = 'finished', finished_at = ?, updated_at = ?
      WHERE project_id = ? AND loop_name = ? AND kind = ? AND section_id = ?
    `).run(at, at, projectId, loopName, target.kind, target.sectionId)
  }

  let stmtSectionIdAt: ReturnType<Database['prepare']> | null = null

  function sectionIdAt(projectId: string, loopName: string, index: number): string | null {
    if (!hasTable(db, 'section_plans')) return null
    if (!stmtSectionIdAt) {
      stmtSectionIdAt = db.prepare(`
        SELECT section_id
        FROM section_plans
        WHERE project_id = ? AND loop_name = ? AND section_index = ?
      `)
    }
    const row = stmtSectionIdAt.get(projectId, loopName, index) as { section_id: string } | null
    return row ? row.section_id : null
  }

  return {
    get,
    getBySession,
    listActive,
    listForLoop(projectId, loopName) {
      const rows = stmtList.all(projectId, loopName) as Array<Record<string, unknown>>
      return rows.map(mapRow)
    },
    activate,
    update,
    incrementError,
    advanceAuditorFallbackIndex,
    finish,
    sectionIdAt,
  }
}
