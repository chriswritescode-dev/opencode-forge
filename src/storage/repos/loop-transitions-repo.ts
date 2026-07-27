import type { Database } from 'bun:sqlite'
import type { Logger } from '../../types'

export interface LoopTransitionRow {
  id: number
  projectId: string
  loopName: string
  eventType: string
  transitionKind: string
  fromPhase: string
  toPhase: string | null
  status: string | null
  reason: string | null
  iteration: number
  sectionIndex: number | null
  createdAt: number
}

export interface LoopTransitionsRepo {
  insert(row: Omit<LoopTransitionRow, 'id' | 'createdAt'>): void
  listForLoop(projectId: string, loopName: string, limit?: number): LoopTransitionRow[]
  /**
   * Newest-N-then-ascending per loop for the whole project, in one scan; loops
   * with no transitions are absent from the map. Same window semantics as
   * `listForLoop`, without the per-loop query.
   */
  listForProject(projectId: string, perLoopLimit: number): Map<string, LoopTransitionRow[]>
}

export function createLoopTransitionsRepo(db: Database, _logger?: Logger): LoopTransitionsRepo {
  const stmtInsert = db.prepare(`
    INSERT INTO loop_transitions (
      project_id, loop_name, event_type, transition_kind, from_phase, to_phase,
      status, reason, iteration, section_index, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  // Newest-N-then-ascending: pick the most recent `limit` rows (id DESC) and
  // re-order them ascending so callers always receive oldest-to-newest, but the
  // window contains the latest transitions rather than the first ones. This
  // keeps long-running / restarted loops showing recent history past row 100
  // instead of permanently displaying rows 1-100.
  const stmtList = db.prepare(`
    SELECT id, project_id, loop_name, event_type, transition_kind, from_phase, to_phase,
           status, reason, iteration, section_index, created_at
    FROM (
      SELECT id, project_id, loop_name, event_type, transition_kind, from_phase, to_phase,
             status, reason, iteration, section_index, created_at
      FROM loop_transitions
      WHERE project_id = ? AND loop_name = ?
      ORDER BY id DESC
      LIMIT ?
    )
    ORDER BY id ASC
  `)

  const stmtListForProject = db.prepare(`
    SELECT id, project_id, loop_name, event_type, transition_kind, from_phase, to_phase,
           status, reason, iteration, section_index, created_at
    FROM (
      SELECT id, project_id, loop_name, event_type, transition_kind, from_phase, to_phase,
             status, reason, iteration, section_index, created_at,
             ROW_NUMBER() OVER (PARTITION BY loop_name ORDER BY id DESC) AS rn
      FROM loop_transitions
      WHERE project_id = ?
    )
    WHERE rn <= ?
    ORDER BY loop_name ASC, id ASC
  `)

  function mapRow(row: Record<string, unknown>): LoopTransitionRow {
    return {
      id: row.id as number,
      projectId: row.project_id as string,
      loopName: row.loop_name as string,
      eventType: row.event_type as string,
      transitionKind: row.transition_kind as string,
      fromPhase: row.from_phase as string,
      toPhase: (row.to_phase as string | null) ?? null,
      status: (row.status as string | null) ?? null,
      reason: (row.reason as string | null) ?? null,
      iteration: row.iteration as number,
      sectionIndex: (row.section_index as number | null) ?? null,
      createdAt: row.created_at as number,
    }
  }

  return {
    insert(row) {
      stmtInsert.run(
        row.projectId,
        row.loopName,
        row.eventType,
        row.transitionKind,
        row.fromPhase,
        row.toPhase,
        row.status ?? null,
        row.reason ?? null,
        row.iteration,
        row.sectionIndex ?? null,
        Date.now(),
      )
    },

    listForLoop(projectId, loopName, limit = 1000) {
      const rows = stmtList.all(projectId, loopName, limit) as Array<Record<string, unknown>>
      return rows.map(mapRow)
    },

    listForProject(projectId, perLoopLimit) {
      const rows = stmtListForProject.all(projectId, perLoopLimit) as Array<Record<string, unknown>>
      const byLoop = new Map<string, LoopTransitionRow[]>()
      for (const raw of rows) {
        const row = mapRow(raw)
        const bucket = byLoop.get(row.loopName)
        if (bucket) bucket.push(row)
        else byLoop.set(row.loopName, [row])
      }
      return byLoop
    },
  }
}
