import type { Database } from 'bun:sqlite'

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
  listByFile(projectId: string, file: string): ReviewFindingRow[]
  delete(projectId: string, file: string, line: number, scope?: DeleteScope): boolean
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

  function mapRaw(raw: {
    project_id: string
    file: string
    line: number
    severity: 'bug' | 'warning'
    description: string
    scenario: string | null
    loop_name: string
    section_index: number | null
    created_at: number
  }): ReviewFindingRow {
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
    const result = stmtWrite.run(
      row.projectId,
      loopToDb(row.loopName),
      row.file,
      row.line,
      row.severity,
      row.description,
      toScenario(row.scenario),
      row.sectionIndex ?? null,
      Date.now()
    ) as unknown as { changes: number }
    if (result.changes > 0) {
      return { ok: true }
    }
    return { ok: false, conflict: true }
  }

  function listAll(projectId: string, sectionIndex?: number | null): ReviewFindingRow[] {
    const rows = stmtListAll.all(projectId) as Array<{
      project_id: string; file: string; line: number; severity: 'bug' | 'warning';
      description: string; scenario: string | null; loop_name: string;
      section_index: number | null; created_at: number
    }>
    let mapped = rows.map(mapRaw)
    if (sectionIndex !== undefined) {
      mapped = mapped.filter(r => r.sectionIndex === sectionIndex)
    }
    return mapped
  }

  function listByLoopName(projectId: string, loopName: string | null, sectionIndex?: number | null): ReviewFindingRow[] {
    const dbLoopName = loopToDb(loopName)
    const rows = stmtListByLoopName.all(projectId, dbLoopName) as Array<{
      project_id: string; file: string; line: number; severity: 'bug' | 'warning';
      description: string; scenario: string | null; loop_name: string;
      section_index: number | null; created_at: number
    }>
    let mapped = rows.map(mapRaw)
    if (sectionIndex !== undefined) {
      mapped = mapped.filter(r => r.sectionIndex === sectionIndex)
    }
    return mapped
  }

  function listByFile(projectId: string, file: string): ReviewFindingRow[] {
    const rows = stmtListByFile.all(projectId, file) as Array<{
      project_id: string; file: string; line: number; severity: 'bug' | 'warning';
      description: string; scenario: string | null; loop_name: string;
      section_index: number | null; created_at: number
    }>
    return rows.map(mapRaw)
  }

  function deleteFinding(projectId: string, file: string, line: number, scope?: DeleteScope): boolean {
    if (scope?.sectionIndex !== undefined) {
      if (scope.sectionIndex === null) {
        const result = db.prepare(`
          DELETE FROM review_findings
          WHERE project_id = ? AND loop_name = ? AND file = ? AND line = ? AND section_index = -1
        `).run(projectId, loopToDb(scope.loopName), file, line) as unknown as { changes: number }
        return result.changes > 0
      }
      const result = stmtDeleteWithLoopNameAndSection.run(projectId, loopToDb(scope.loopName), file, line, scope.sectionIndex) as unknown as { changes: number }
      return result.changes > 0
    }
    if (scope) {
      const result = stmtDeleteWithLoopName.run(projectId, loopToDb(scope.loopName), file, line) as unknown as { changes: number }
      return result.changes > 0
    }
    const result = stmtDelete.run(projectId, file, line) as unknown as { changes: number }
    return result.changes > 0
  }

  return {
    write,
    listAll,
    listByLoopName,
    listByFile,
    delete: deleteFinding,
  }
}
