import type { Database } from 'bun:sqlite'
import { sectionRunKey, type SectionRunKind, type SectionRunTarget } from '../../loop/section-run'
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
}

export interface SectionRunActivateFields {
  sessionId: string
  phase: SectionRunPhase
  standbySessionId: string | null
}

export interface SectionRunActivePatch {
  sessionId?: string
  phase?: SectionRunPhase
  standbySessionId?: string | null
}

export interface SectionRunsRepo {
  getActive(projectId: string, loopName: string): SectionRunRow | null
  listForLoop(projectId: string, loopName: string): SectionRunRow[]
  activate(
    projectId: string,
    loopName: string,
    target: SectionRunTarget,
    fields: SectionRunActivateFields,
    now?: number,
  ): void
  updateActive(
    projectId: string,
    loopName: string,
    patch: SectionRunActivePatch,
    now?: number,
  ): void
  moveActive(projectId: string, loopName: string, target: SectionRunTarget, now?: number): void
  sectionIdAt(projectId: string, loopName: string, index: number): string | null
}

const RUN_COLUMNS = `project_id, loop_name, kind, section_id, section_index, phase, session_id,
  standby_session_id, status, started_at, updated_at, finished_at`

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
  }
}

export function createSectionRunsRepo(db: Database): SectionRunsRepo {
  const stmtGetActive = db.prepare(`
    SELECT ${RUN_COLUMNS}
    FROM section_runs
    WHERE project_id = ? AND loop_name = ? AND status = 'active'
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
      standby_session_id, status, started_at, updated_at, finished_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
    ON CONFLICT (project_id, loop_name, kind, section_id) DO UPDATE SET
      section_index = excluded.section_index,
      phase = excluded.phase,
      session_id = excluded.session_id,
      standby_session_id = excluded.standby_session_id,
      status = 'active',
      updated_at = excluded.updated_at,
      finished_at = NULL
  `)

  const stmtUpdateIndex = db.prepare(`
    UPDATE section_runs
    SET section_index = ?, updated_at = ?
    WHERE project_id = ? AND loop_name = ? AND status = 'active'
  `)

  const activateTx = db.transaction((...args: unknown[]) => {
    const [projectId, loopName, target, fields, at] = args as [
      string,
      string,
      SectionRunTarget,
      SectionRunActivateFields,
      number,
    ]
    stmtFinishOthers.run(at, at, projectId, loopName, target.kind, target.sectionId)
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
    )
  })

  function getActive(projectId: string, loopName: string): SectionRunRow | null {
    const row = stmtGetActive.get(projectId, loopName) as Record<string, unknown> | null
    return row ? mapRow(row) : null
  }

  function activate(
    projectId: string,
    loopName: string,
    target: SectionRunTarget,
    fields: SectionRunActivateFields,
    now?: number,
  ): void {
    activateTx(projectId, loopName, target, fields, now ?? Date.now())
  }

  function updateActive(
    projectId: string,
    loopName: string,
    patch: SectionRunActivePatch,
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
    if (assignments.length === 0) return
    assignments.push('updated_at = ?')
    params.push(now ?? Date.now())
    db.prepare(`
      UPDATE section_runs
      SET ${assignments.join(', ')}
      WHERE project_id = ? AND loop_name = ? AND status = 'active'
    `).run(...params, projectId, loopName)
  }

  function moveActive(
    projectId: string,
    loopName: string,
    target: SectionRunTarget,
    now?: number,
  ): void {
    const active = getActive(projectId, loopName)
    if (!active) return
    if (active.sectionRunKey === sectionRunKey(target.kind, target.sectionId)) {
      stmtUpdateIndex.run(target.sectionIndex, now ?? Date.now(), projectId, loopName)
      return
    }
    activate(
      projectId,
      loopName,
      target,
      {
        sessionId: active.sessionId,
        phase: active.phase,
        standbySessionId: active.standbySessionId,
      },
      now,
    )
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
    getActive,
    listForLoop(projectId, loopName) {
      const rows = stmtList.all(projectId, loopName) as Array<Record<string, unknown>>
      return rows.map(mapRow)
    },
    activate,
    updateActive,
    moveActive,
    sectionIdAt,
  }
}
