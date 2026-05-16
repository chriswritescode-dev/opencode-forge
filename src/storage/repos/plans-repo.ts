import type { Database } from 'bun:sqlite'

export interface PlanRow {
  projectId: string
  loopName: string | null
  sessionId: string | null
  content: string
  updatedAt: number
}

export interface ListRecentPlansOptions {
  limit?: number
}

export interface PlansRepo {
  writeForSession(projectId: string, sessionId: string, content: string): void
  writeForLoop(projectId: string, loopName: string, content: string): void
  getForSession(projectId: string, sessionId: string): PlanRow | null
  getForLoop(projectId: string, loopName: string): PlanRow | null
  getForLoopOrSession(projectId: string, loopName: string, sessionId: string): PlanRow | null
  promote(projectId: string, sessionId: string, loopName: string): boolean
  deleteForSession(projectId: string, sessionId: string): void
  deleteForLoop(projectId: string, loopName: string): void
  listRecent(projectId: string, opts?: ListRecentPlansOptions): PlanRow[]
  searchRecent(projectId: string, pattern: RegExp, opts?: ListRecentPlansOptions): PlanRow[]
}

export function createPlansRepo(db: Database): PlansRepo {
  type RawRow = { project_id: string; loop_name: string | null; session_id: string | null; content: string; updated_at: number }

  function mapRow(row: RawRow): PlanRow {
    return {
      projectId: row.project_id,
      loopName: row.loop_name,
      sessionId: row.session_id,
      content: row.content,
      updatedAt: row.updated_at,
    }
  }

  const stmtWriteForSession = db.prepare(`
    INSERT OR REPLACE INTO plans (project_id, session_id, content, updated_at)
    VALUES (?, ?, ?, ?)
  `)

  const stmtWriteForLoop = db.prepare(`
    INSERT OR REPLACE INTO plans (project_id, loop_name, content, updated_at)
    VALUES (?, ?, ?, ?)
  `)

  const stmtGetForSession = db.prepare(`
    SELECT project_id, loop_name, session_id, content, updated_at
    FROM plans
    WHERE project_id = ? AND session_id = ?
  `)

  const stmtGetForLoop = db.prepare(`
    SELECT project_id, loop_name, session_id, content, updated_at
    FROM plans
    WHERE project_id = ? AND loop_name = ?
  `)

  const stmtPromote = db.prepare(`
    UPDATE plans
    SET loop_name = ?, session_id = NULL
    WHERE project_id = ? AND session_id = ?
  `)

  const stmtDeleteForSession = db.prepare(`
    DELETE FROM plans
    WHERE project_id = ? AND session_id = ?
  `)

  const stmtDeleteForLoop = db.prepare(`
    DELETE FROM plans
    WHERE project_id = ? AND loop_name = ?
  `)

  const stmtListRecent = db.prepare(`
    SELECT project_id, loop_name, session_id, content, updated_at
    FROM plans
    WHERE project_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `)

  function writeForSession(projectId: string, sessionId: string, content: string): void {
    stmtWriteForSession.run(projectId, sessionId, content, Date.now())
  }

  function writeForLoop(projectId: string, loopName: string, content: string): void {
    stmtWriteForLoop.run(projectId, loopName, content, Date.now())
  }

  function getForSession(projectId: string, sessionId: string): PlanRow | null {
    const row = stmtGetForSession.get(projectId, sessionId) as RawRow | undefined
    if (!row) return null
    return mapRow(row)
  }

  function getForLoop(projectId: string, loopName: string): PlanRow | null {
    const row = stmtGetForLoop.get(projectId, loopName) as RawRow | undefined
    if (!row) return null
    return mapRow(row)
  }

  function getForLoopOrSession(projectId: string, loopName: string, sessionId: string): PlanRow | null {
    return getForLoop(projectId, loopName) ?? getForSession(projectId, sessionId)
  }

  function promote(projectId: string, sessionId: string, loopName: string): boolean {
    const result = stmtPromote.run(loopName, projectId, sessionId) as unknown as { changes: number }
    return result.changes > 0
  }

  function deleteForSession(projectId: string, sessionId: string): void {
    stmtDeleteForSession.run(projectId, sessionId)
  }

  function deleteForLoop(projectId: string, loopName: string): void {
    stmtDeleteForLoop.run(projectId, loopName)
  }

  function clampLimit(limit: number | undefined, defaultLimit: number): number {
    if (limit === undefined) return defaultLimit
    return Math.max(1, Math.min(100, limit))
  }

  function listRecent(projectId: string, opts?: ListRecentPlansOptions): PlanRow[] {
    const limit = clampLimit(opts?.limit, 20)
    return (stmtListRecent.all(projectId, limit) as RawRow[]).map(mapRow)
  }

  function searchRecent(projectId: string, pattern: RegExp, opts?: ListRecentPlansOptions): PlanRow[] {
    const limit = clampLimit(opts?.limit, 20)
    const scanWindow = Math.max(limit * 5, 100)
    const rows = (stmtListRecent.all(projectId, scanWindow) as RawRow[]).map(mapRow)
    const results: PlanRow[] = []
    for (const row of rows) {
      pattern.lastIndex = 0
      if (pattern.test(row.content)) {
        results.push(row)
        if (results.length >= limit) break
      }
    }
    return results
  }

  return {
    writeForSession,
    writeForLoop,
    getForSession,
    getForLoop,
    getForLoopOrSession,
    promote,
    deleteForSession,
    deleteForLoop,
    listRecent,
    searchRecent,
  }
}
