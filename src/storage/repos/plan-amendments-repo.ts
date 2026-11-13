import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { Logger } from '../../types'

const planAmendmentRowSchema = z.object({
  id: z.number(),
  project_id: z.string(),
  loop_name: z.string(),
  source: z.string(),
  rationale: z.string(),
  applied_at_section: z.number(),
  sections_before: z.string(),
  sections_after: z.string(),
  created_at: z.number(),
})
const planAmendmentRowsSchema = z.array(planAmendmentRowSchema)

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
  get(projectId: string, loopName: string, id: number): PlanAmendmentRow | null
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

  const stmtGet = db.prepare(`
    SELECT id, project_id, loop_name, source, rationale, applied_at_section, sections_before, sections_after, created_at
    FROM plan_amendments
    WHERE project_id = ? AND loop_name = ? AND id = ?
  `)

  function mapRow(row: z.infer<typeof planAmendmentRowSchema>): PlanAmendmentRow {
    return {
      id: row.id,
      projectId: row.project_id,
      loopName: row.loop_name,
      source: row.source,
      rationale: row.rationale,
      appliedAtSection: row.applied_at_section,
      sectionsBefore: row.sections_before,
      sectionsAfter: row.sections_after,
      createdAt: row.created_at,
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
      const rows = planAmendmentRowsSchema.parse(stmtList.all(projectId, loopName))
      return rows.map(mapRow)
    },

    get(projectId, loopName, id) {
      const row = planAmendmentRowSchema.nullish().parse(stmtGet.get(projectId, loopName, id))
      return row ? mapRow(row) : null
    },
  }
}
