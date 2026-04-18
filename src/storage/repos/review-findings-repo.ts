import type { Database } from 'bun:sqlite'

export interface ReviewFindingRow {
  projectId: string
  file: string
  line: number
  severity: 'bug' | 'warning'
  description: string
  scenario: string
  branch: string | null
  createdAt: number
}

export interface WriteFindingResult {
  ok: boolean
  conflict?: boolean
}

export interface ReviewFindingsRepo {
  write(row: Omit<ReviewFindingRow, 'createdAt'>): WriteFindingResult
  listAll(projectId: string): ReviewFindingRow[]
  listByBranch(projectId: string, branch: string | null): ReviewFindingRow[]
  listByFile(projectId: string, file: string): ReviewFindingRow[]
  delete(projectId: string, file: string, line: number): boolean
}

export function createReviewFindingsRepo(db: Database): ReviewFindingsRepo {
  const stmtWrite = db.prepare(`
    INSERT INTO review_findings (project_id, file, line, severity, description, scenario, branch, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, file, line) DO NOTHING
    RETURNING 1
  `)

  const stmtListAll = db.prepare(`
    SELECT project_id, file, line, severity, description, scenario, branch, created_at
    FROM review_findings
    WHERE project_id = ?
    ORDER BY file, line
  `)

  const stmtListByBranch = db.prepare(`
    SELECT project_id, file, line, severity, description, scenario, branch, created_at
    FROM review_findings
    WHERE project_id = ? AND (branch = ? OR (branch IS NULL AND ? IS NULL))
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

  function write(row: Omit<ReviewFindingRow, 'createdAt'>): WriteFindingResult {
    const result = stmtWrite.run(
      row.projectId,
      row.file,
      row.line,
      row.severity,
      row.description,
      row.scenario,
      row.branch,
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
      scenario: string
      branch: string | null
      created_at: number
    }>
    return rows.map(row => ({
      projectId: row.project_id,
      file: row.file,
      line: row.line,
      severity: row.severity,
      description: row.description,
      scenario: row.scenario,
      branch: row.branch,
      createdAt: row.created_at,
    }))
  }

  function listByBranch(projectId: string, branch: string | null): ReviewFindingRow[] {
    const rows = stmtListByBranch.all(projectId, branch, branch) as Array<{
      project_id: string
      file: string
      line: number
      severity: 'bug' | 'warning'
      description: string
      scenario: string
      branch: string | null
      created_at: number
    }>
    return rows.map(row => ({
      projectId: row.project_id,
      file: row.file,
      line: row.line,
      severity: row.severity,
      description: row.description,
      scenario: row.scenario,
      branch: row.branch,
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
      scenario: string
      branch: string | null
      created_at: number
    }>
    return rows.map(row => ({
      projectId: row.project_id,
      file: row.file,
      line: row.line,
      severity: row.severity,
      description: row.description,
      scenario: row.scenario,
      branch: row.branch,
      createdAt: row.created_at,
    }))
  }

  function deleteFinding(projectId: string, file: string, line: number): boolean {
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
