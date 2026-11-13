import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { Logger } from '../../types'

const loopTransitionRowSchema = z.object({
  id: z.number(),
  project_id: z.string(),
  loop_name: z.string(),
  event_type: z.string(),
  transition_kind: z.string(),
  from_phase: z.string(),
  to_phase: z.string().nullable(),
  status: z.string().nullable(),
  reason: z.string().nullable(),
  iteration: z.number(),
  section_index: z.number().nullable(),
  created_at: z.number(),
})
const loopTransitionRowsSchema = z.array(loopTransitionRowSchema)

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
}

export function createLoopTransitionsRepo(db: Database, _logger?: Logger): LoopTransitionsRepo {
  const stmtInsert = db.prepare(`
    INSERT INTO loop_transitions (
      project_id, loop_name, event_type, transition_kind, from_phase, to_phase,
      status, reason, iteration, section_index, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

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

  function mapRow(row: z.infer<typeof loopTransitionRowSchema>): LoopTransitionRow {
    return {
      id: row.id,
      projectId: row.project_id,
      loopName: row.loop_name,
      eventType: row.event_type,
      transitionKind: row.transition_kind,
      fromPhase: row.from_phase,
      toPhase: row.to_phase,
      status: row.status,
      reason: row.reason,
      iteration: row.iteration,
      sectionIndex: row.section_index,
      createdAt: row.created_at,
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
      const rows = loopTransitionRowsSchema.parse(stmtList.all(projectId, loopName, limit))
      return rows.map(mapRow)
    },
  }
}
