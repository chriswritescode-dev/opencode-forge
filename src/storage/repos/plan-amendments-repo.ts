import type { Database } from 'bun:sqlite'
import type { Logger } from '../../types'

export interface PlanAmendmentRow {
  id: number
  projectId: string
  loopName: string
  source: string
  rationale: string
  appliedAtSection: number
  sectionsBefore: string
  sectionsAfter: string
  createdAt: number
}

export interface PlanAmendmentsRepo {
  insert(row: Omit<PlanAmendmentRow, 'id' | 'createdAt'>): void
  listForLoop(projectId: string, loopName: string): PlanAmendmentRow[]
}

export function createPlanAmendmentsRepo(db: Database, _logger?: Logger): PlanAmendmentsRepo {
  const stmtInsert = db.prepare(`
    INSERT INTO plan_amendments (
      project_id, loop_name, source, rationale, applied_at_section, sections_before, sections_after, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const stmtList = db.prepare(`
    SELECT id, project_id, loop_name, source, rationale, applied_at_section, sections_before, sections_after, created_at
    FROM plan_amendments
    WHERE project_id = ? AND loop_name = ?
    ORDER BY id ASC
  `)

  function mapRow(row: Record<string, unknown>): PlanAmendmentRow {
    return {
      id: row.id as number,
      projectId: row.project_id as string,
      loopName: row.loop_name as string,
      source: row.source as string,
      rationale: row.rationale as string,
      appliedAtSection: row.applied_at_section as number,
      sectionsBefore: row.sections_before as string,
      sectionsAfter: row.sections_after as string,
      createdAt: row.created_at as number,
    }
  }

  return {
    insert(row) {
      stmtInsert.run(
        row.projectId,
        row.loopName,
        row.source,
        row.rationale,
        row.appliedAtSection,
        row.sectionsBefore,
        row.sectionsAfter,
        Date.now(),
      )
    },

    listForLoop(projectId, loopName) {
      const rows = stmtList.all(projectId, loopName) as Array<Record<string, unknown>>
      return rows.map(mapRow)
    },
  }
}
