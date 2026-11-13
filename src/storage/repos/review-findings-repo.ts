import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { statementChanges } from '../sqlite-open'

const reviewFindingRowSchema = z.object({
  project_id: z.string(),
  file: z.string(),
  line: z.number(),
  severity: z.enum(['bug', 'warning']),
  description: z.string(),
  scenario: z.string().nullable(),
  loop_name: z.string(),
  section_index: z.number().nullable(),
  created_at: z.number(),
})
const reviewFindingRowsSchema = z.array(reviewFindingRowSchema)

const loopBugCountRowSchema = z.object({ loop_name: z.string(), cnt: z.number() })
const loopBugCountRowsSchema = z.array(loopBugCountRowSchema)

export interface ReviewFindingRow {
  projectId: string
  file: string
  line: number
  severity: 'bug' | 'warning'
  description: string
  scenario: string | null
  loopName: string | null
  sectionIndex: number | null
  createdAt: number
}

export interface WriteFindingResult {
  ok: boolean
  conflict?: boolean
}

type DeleteScope = { loopName: string | null; sectionIndex?: number | null }

export interface ReviewFindingsRepo {
  write(row: Omit<ReviewFindingRow, 'createdAt' | 'scenario' | 'sectionIndex'> & { scenario?: string | null; sectionIndex?: number | null }): WriteFindingResult
  listAll(projectId: string, sectionIndex?: number | null): ReviewFindingRow[]
  listByLoopName(projectId: string, loopName: string | null, sectionIndex?: number | null): ReviewFindingRow[]
  bugCountsByLoop(projectId: string): Map<string, number>
  listByFile(projectId: string, file: string): ReviewFindingRow[]
  delete(projectId: string, file: string, line: number, scope?: DeleteScope): boolean
  deleteByLoopName(projectId: string, loopName: string): number
}

export function createReviewFindingsRepo(db: Database): ReviewFindingsRepo {
  function loopToDb(loopName: string | null | undefined): string {
    return loopName ?? ''
  }

  function loopFromDb(loopName: string): string | null {
    return loopName === '' ? null : loopName
  }

  const stmtWrite = db.prepare(`
    INSERT INTO review_findings (project_id, loop_name, file, line, severity, description, scenario, section_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, -1), ?)
    ON CONFLICT (project_id, loop_name, file, line, section_index) DO NOTHING
    RETURNING 1
  `)

  function toScenario(value: string | null | undefined): string | null {
    if (value === undefined || value === '') {
      return null
    }
    return value
  }

  const SELECT_COLS = 'project_id, file, line, severity, description, scenario, loop_name, section_index, created_at'

  const stmtListAll = db.prepare(`
    SELECT ${SELECT_COLS}
    FROM review_findings
    WHERE project_id = ?
    ORDER BY file, line
  `)

  const stmtListByLoopName = db.prepare(`
    SELECT ${SELECT_COLS}
    FROM review_findings
    WHERE project_id = ? AND loop_name = ?
    ORDER BY file, line
  `)

  const stmtBugCountsByLoop = db.prepare(`
    SELECT loop_name, COUNT(*) AS cnt
    FROM review_findings
    WHERE project_id = ? AND severity = 'bug'
    GROUP BY loop_name
  `)

  const stmtListByFile = db.prepare(`
    SELECT ${SELECT_COLS}
    FROM review_findings
    WHERE project_id = ? AND file = ?
    ORDER BY line
  `)

  const stmtDelete = db.prepare(`
    DELETE FROM review_findings
    WHERE project_id = ? AND file = ? AND line = ?
  `)

  const stmtDeleteWithLoopName = db.prepare(`
    DELETE FROM review_findings
    WHERE project_id = ? AND loop_name = ? AND file = ? AND line = ?
  `)

  const stmtDeleteWithLoopNameAndSection = db.prepare(`
    DELETE FROM review_findings
    WHERE project_id = ? AND loop_name = ? AND file = ? AND line = ? AND section_index = ?
  `)

  const stmtDeleteByLoopName = db.prepare(`
    DELETE FROM review_findings
    WHERE project_id = ? AND loop_name = ?
  `)

  function mapRaw(raw: z.infer<typeof reviewFindingRowSchema>): ReviewFindingRow {
    return {
      projectId: raw.project_id,
      file: raw.file,
      line: raw.line,
      severity: raw.severity,
      description: raw.description,
      scenario: raw.scenario,
      loopName: loopFromDb(raw.loop_name),
      sectionIndex: raw.section_index === -1 ? null : raw.section_index,
      createdAt: raw.created_at,
    }
  }

  function write(row: Omit<ReviewFindingRow, 'createdAt' | 'scenario' | 'sectionIndex'> & { scenario?: string | null; sectionIndex?: number | null }): WriteFindingResult {
    const changes = statementChanges(stmtWrite.run(
      row.projectId,
      loopToDb(row.loopName),
      row.file,
      row.line,
      row.severity,
      row.description,
      toScenario(row.scenario),
      row.sectionIndex ?? null,
      Date.now()
    ))
    if (changes > 0) {
      return { ok: true }
    }
    return { ok: false, conflict: true }
  }

  function listAll(projectId: string, sectionIndex?: number | null): ReviewFindingRow[] {
    const rows = reviewFindingRowsSchema.parse(stmtListAll.all(projectId))
    let mapped = rows.map(mapRaw)
    if (sectionIndex !== undefined) {
      mapped = mapped.filter(r => r.sectionIndex === sectionIndex)
    }
    return mapped
  }

  function listByLoopName(projectId: string, loopName: string | null, sectionIndex?: number | null): ReviewFindingRow[] {
    const dbLoopName = loopToDb(loopName)
    const rows = reviewFindingRowsSchema.parse(stmtListByLoopName.all(projectId, dbLoopName))
    let mapped = rows.map(mapRaw)
    if (sectionIndex !== undefined) {
      mapped = mapped.filter(r => r.sectionIndex === sectionIndex)
    }
    return mapped
  }

  function bugCountsByLoop(projectId: string): Map<string, number> {
    const rows = loopBugCountRowsSchema.parse(stmtBugCountsByLoop.all(projectId))
    return new Map(rows.map(r => [r.loop_name, r.cnt]))
  }

  function listByFile(projectId: string, file: string): ReviewFindingRow[] {
    const rows = reviewFindingRowsSchema.parse(stmtListByFile.all(projectId, file))
    return rows.map(mapRaw)
  }

  function deleteFinding(projectId: string, file: string, line: number, scope?: DeleteScope): boolean {
    if (scope?.sectionIndex !== undefined) {
      if (scope.sectionIndex === null) {
        const changes = statementChanges(db.prepare(`
          DELETE FROM review_findings
          WHERE project_id = ? AND loop_name = ? AND file = ? AND line = ? AND section_index = -1
        `).run(projectId, loopToDb(scope.loopName), file, line))
        return changes > 0
      }
      const changes = statementChanges(stmtDeleteWithLoopNameAndSection.run(projectId, loopToDb(scope.loopName), file, line, scope.sectionIndex))
      return changes > 0
    }
    if (scope) {
      const changes = statementChanges(stmtDeleteWithLoopName.run(projectId, loopToDb(scope.loopName), file, line))
      return changes > 0
    }
    const changes = statementChanges(stmtDelete.run(projectId, file, line))
    return changes > 0
  }

  function deleteByLoopName(projectId: string, loopName: string): number {
    return statementChanges(stmtDeleteByLoopName.run(projectId, loopName))
  }

  return {
    write,
    listAll,
    listByLoopName,
    bugCountsByLoop,
    listByFile,
    delete: deleteFinding,
    deleteByLoopName,
  }
}
