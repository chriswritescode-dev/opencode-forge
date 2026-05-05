import type { Database } from 'bun:sqlite'

export interface ReviewFindingRow {
  projectId: string
  file: string
  line: number
  severity: 'bug' | 'warning'
  description: string
  scenario: string | null
  branch: string | null
  loopName: string | null
  createdAt: number
}

export interface WriteFindingResult {
  ok: boolean
  conflict?: boolean
}

type DeleteScope = { branch?: string | null } | { loopName: string | null }

export interface ReviewFindingsRepo {
  write(row: Omit<ReviewFindingRow, 'createdAt' | 'scenario'> & { scenario?: string | null }): WriteFindingResult
  listAll(projectId: string): ReviewFindingRow[]
  listByBranch(projectId: string, branch: string | null): ReviewFindingRow[]
  listByLoopName(projectId: string, loopName: string | null): ReviewFindingRow[]
  listByFile(projectId: string, file: string): ReviewFindingRow[]
  delete(projectId: string, file: string, line: number, scope?: DeleteScope): boolean
}

export function createReviewFindingsRepo(db: Database): ReviewFindingsRepo {
  function branchToDb(branch: string | null | undefined): string {
    return branch ?? ''
  }

  function branchFromDb(branch: string): string | null {
    return branch === '' ? null : branch
  }

  function loopToDb(loopName: string | null | undefined): string {
    return loopName ?? ''
  }

  function loopFromDb(loopName: string): string | null {
    return loopName === '' ? null : loopName
  }

  const stmtWrite = db.prepare(`
    INSERT INTO review_findings (project_id, branch, loop_name, file, line, severity, description, scenario, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, branch, loop_name, file, line) DO NOTHING
    RETURNING 1
  `)

  function toScenario(value: string | null | undefined): string | null {
    if (value === undefined || value === '') {
      return null
    }
    return value
  }

  const stmtListAll = db.prepare(`
    SELECT project_id, file, line, severity, description, scenario, branch, loop_name, created_at
    FROM review_findings
    WHERE project_id = ?
    ORDER BY file, line
  `)

  const stmtListByBranch = db.prepare(`
    SELECT project_id, file, line, severity, description, scenario, branch, loop_name, created_at
    FROM review_findings
    WHERE project_id = ? AND branch = ? AND loop_name = ''
    ORDER BY file, line
  `)

  const stmtListByLoopName = db.prepare(`
    SELECT project_id, file, line, severity, description, scenario, branch, loop_name, created_at
    FROM review_findings
    WHERE project_id = ? AND loop_name = ? AND branch = ''
    ORDER BY file, line
  `)

  const stmtListByFile = db.prepare(`
    SELECT project_id, file, line, severity, description, scenario, branch, loop_name, created_at
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
    WHERE project_id = ? AND branch = ? AND loop_name = '' AND file = ? AND line = ?
  `)

  const stmtDeleteWithLoopName = db.prepare(`
    DELETE FROM review_findings
    WHERE project_id = ? AND loop_name = ? AND branch = '' AND file = ? AND line = ?
  `)

  function write(row: Omit<ReviewFindingRow, 'createdAt' | 'scenario'> & { scenario?: string | null }): WriteFindingResult {
    // Enforce mutually exclusive branch/loopName
    if (row.branch != null && row.branch !== '' && row.loopName != null && row.loopName !== '') {
      throw new Error('Cannot write finding with both branch and loopName set')
    }
    const result = stmtWrite.run(
      row.projectId,
      branchToDb(row.branch),
      loopToDb(row.loopName),
      row.file,
      row.line,
      row.severity,
      row.description,
      toScenario(row.scenario),
      Date.now()
    ) as unknown as { changes: number }
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
      loop_name: string
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
      loopName: loopFromDb(row.loop_name),
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
      loop_name: string
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
      loopName: loopFromDb(row.loop_name),
      createdAt: row.created_at,
    }))
  }

  function listByLoopName(projectId: string, loopName: string | null): ReviewFindingRow[] {
    const dbLoopName = loopToDb(loopName)
    const rows = stmtListByLoopName.all(projectId, dbLoopName) as Array<{
      project_id: string
      file: string
      line: number
      severity: 'bug' | 'warning'
      description: string
      scenario: string | null
      branch: string
      loop_name: string
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
      loopName: loopFromDb(row.loop_name),
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
      loop_name: string
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
      loopName: loopFromDb(row.loop_name),
      createdAt: row.created_at,
    }))
  }

  function deleteFinding(projectId: string, file: string, line: number, scope?: DeleteScope): boolean {
    if (scope && 'branch' in scope) {
      const result = stmtDeleteWithBranch.run(projectId, branchToDb(scope.branch), file, line) as unknown as { changes: number }
      return result.changes > 0
    }
    if (scope && 'loopName' in scope) {
      const result = stmtDeleteWithLoopName.run(projectId, loopToDb(scope.loopName), file, line) as unknown as { changes: number }
      return result.changes > 0
    }
    const result = stmtDelete.run(projectId, file, line) as unknown as { changes: number }
    return result.changes > 0
  }

  return {
    write,
    listAll,
    listByBranch,
    listByLoopName,
    listByFile,
    delete: deleteFinding,
  }
}
