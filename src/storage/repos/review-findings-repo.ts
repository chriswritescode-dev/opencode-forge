import type { Database } from 'bun:sqlite'

export interface ReviewFindingRow {
  projectId: string
  file: string
  line: number
  severity: 'bug' | 'warning'
  description: string
  scenario: string | null
  branch: string | null
  createdAt: number
}

export interface WriteFindingResult {
  ok: boolean
  conflict?: boolean
}

export interface ReviewFindingsRepo {
  write(row: Omit<ReviewFindingRow, 'createdAt' | 'scenario'> & { scenario?: string | null }): WriteFindingResult
  listAll(projectId: string): ReviewFindingRow[]
  listByBranch(projectId: string, branch: string | null): ReviewFindingRow[]
  listByFile(projectId: string, file: string): ReviewFindingRow[]
  delete(projectId: string, file: string, line: number, branch?: string | null): boolean
}

export function createReviewFindingsRepo(db: Database): ReviewFindingsRepo {
  function branchToDb(branch: string | null | undefined): string {
    return branch ?? ''
  }

  function branchFromDb(branch: string): string | null {
    return branch === '' ? null : branch
  }

  const stmtWrite = db.prepare(`
    INSERT INTO review_findings (project_id, branch, file, line, severity, description, scenario, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, branch, file, line) DO NOTHING
    RETURNING 1
  `)

  function toScenario(value: string | null | undefined): string | null {
    if (value === undefined || value === '') {
      return null
    }
    return value
  }

  const stmtListAll = db.prepare(`
    SELECT project_id, file, line, severity, description, scenario, branch, created_at
    FROM review_findings
    WHERE project_id = ?
    ORDER BY file, line
  `)

  const stmtListByBranch = db.prepare(`
    SELECT project_id, file, line, severity, description, scenario, branch, created_at
    FROM review_findings
    WHERE project_id = ? AND branch = ?
    ORDER BY file, line
  `)

  const stmtListByFile = db.prepare(`
    SELECT project_id, file, line, severity, description, scenario, branch, created_at
    FROM review_findings
    WHERE project_id = ? AND file = ?
    ORDER BY line
  `)

  const stmtDelete = db.prepare(`
    DELETE FROM review_findings
    WHERE project_id = ? AND file = ? AND line = ?
  `)

  const stmtDeleteWithBranch = db.prepare(`
    DELETE FROM review_findings
    WHERE project_id = ? AND branch = ? AND file = ? AND line = ?
  `)

  function write(row: Omit<ReviewFindingRow, 'createdAt' | 'scenario'> & { scenario?: string | null }): WriteFindingResult {
    const result = stmtWrite.run(
      row.projectId,
      branchToDb(row.branch),
      row.file,
      row.line,
      row.severity,
      row.description,
      toScenario(row.scenario),
      Date.now()
    )
    if (result.changes > 0) {
      return { ok: true }
    }
    return { ok: false, conflict: true }
  }

  function listAll(projectId: string): ReviewFindingRow[] {
    const rows = stmtListAll.all(projectId) as Array<{
      project_id: string
      file: string
      line: number
      severity: 'bug' | 'warning'
      description: string
      scenario: string | null
      branch: string
      created_at: number
    }>
    return rows.map(row => ({
      projectId: row.project_id,
      file: row.file,
      line: row.line,
      severity: row.severity,
      description: row.description,
      scenario: row.scenario,
      branch: branchFromDb(row.branch),
      createdAt: row.created_at,
    }))
  }

  function listByBranch(projectId: string, branch: string | null): ReviewFindingRow[] {
    const dbBranch = branchToDb(branch)
    const rows = stmtListByBranch.all(projectId, dbBranch) as Array<{
      project_id: string
      file: string
      line: number
      severity: 'bug' | 'warning'
      description: string
      scenario: string | null
      branch: string
      created_at: number
    }>
    return rows.map(row => ({
      projectId: row.project_id,
      file: row.file,
      line: row.line,
      severity: row.severity,
      description: row.description,
      scenario: row.scenario,
      branch: branchFromDb(row.branch),
      createdAt: row.created_at,
    }))
  }

  function listByFile(projectId: string, file: string): ReviewFindingRow[] {
    const rows = stmtListByFile.all(projectId, file) as Array<{
      project_id: string
      file: string
      line: number
      severity: 'bug' | 'warning'
      description: string
      scenario: string | null
      branch: string
      created_at: number
    }>
    return rows.map(row => ({
      projectId: row.project_id,
      file: row.file,
      line: row.line,
      severity: row.severity,
      description: row.description,
      scenario: row.scenario,
      branch: branchFromDb(row.branch),
      createdAt: row.created_at,
    }))
  }

  function deleteFinding(projectId: string, file: string, line: number, branch?: string | null): boolean {
    if (branch !== undefined) {
      const result = stmtDeleteWithBranch.run(projectId, branchToDb(branch), file, line)
      return result.changes > 0
    }
    const result = stmtDelete.run(projectId, file, line)
    return result.changes > 0
  }

  return {
    write,
    listAll,
    listByBranch,
    listByFile,
    delete: deleteFinding,
  }
}
