import type { Database, Statement } from 'bun:sqlite'

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

export interface UnexecutedPlanRow {
  projectId: string
  sessionId: string
  content: string
  updatedAt: number
}

export interface PlansRepo {
  writeForSession(projectId: string, sessionId: string, content: string): void
  writeForLoop(projectId: string, loopName: string, content: string): void
  getForSession(projectId: string, sessionId: string): PlanRow | null
  getForLoop(projectId: string, loopName: string): PlanRow | null
  getForLoopOrSession(projectId: string, loopName: string, sessionId: string): PlanRow | null
  promote(projectId: string, sessionId: string, loopName: string): boolean
  /** Delete a session-scoped plan; returns whether a row was deleted. */
  deleteForSession(projectId: string, sessionId: string): boolean
  deleteForLoop(projectId: string, loopName: string): void
  listRecent(projectId: string, opts?: ListRecentPlansOptions): PlanRow[]
  searchRecent(projectId: string, pattern: RegExp, opts?: ListRecentPlansOptions): PlanRow[]
  /**
   * Session-scoped plans no loop has executed, newest first. A plan counts as
   * executed when a loop was launched from its session at or after the plan's last
   * write, because the launch copies the stored plan into the loop row.
   */
  listUnexecuted(projectId: string): UnexecutedPlanRow[]
  /** Count of unexecuted session-scoped plans per project, for discovery and always-populated counts. */
  unexecutedCountsByProject(): Map<string, number>
  /** Loop names in this project that have a persisted plan row. Session-scoped plans (loop_name IS NULL) are excluded. */
  listLoopNames(projectId: string): string[]
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

  const stmtListLoopNames = db.prepare(`
    SELECT loop_name
    FROM plans
    WHERE project_id = ? AND loop_name IS NOT NULL
  `)

  // "This plan has not been executed": a session-scoped plan row whose session
  // has no loop launched at or after the plan's last write. Shared by the row and
  // count queries so the two cannot drift. Prepared on first use because the
  // queries join `loops`, which a plans-only database (e.g. a focused test) does
  // not necessarily have.
  const UNEXECUTED_PLAN_PREDICATE = `p.loop_name IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM loops l
      WHERE l.project_id = p.project_id
        AND l.host_session_id = p.session_id
        AND l.started_at >= p.updated_at
    )`

  let unexecutedStatements: { rows: Statement; counts: Statement } | null = null
  function getUnexecutedStatements(): { rows: Statement; counts: Statement } {
    unexecutedStatements ??= {
      rows: db.prepare(`
        SELECT p.project_id, p.session_id, p.content, p.updated_at
        FROM plans p
        WHERE p.project_id = ? AND ${UNEXECUTED_PLAN_PREDICATE}
        ORDER BY p.updated_at DESC
      `),
      counts: db.prepare(`
        SELECT p.project_id, COUNT(*) AS cnt
        FROM plans p
        WHERE ${UNEXECUTED_PLAN_PREDICATE}
        GROUP BY p.project_id
      `),
    }
    return unexecutedStatements
  }

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

  function deleteForSession(projectId: string, sessionId: string): boolean {
    const result = stmtDeleteForSession.run(projectId, sessionId) as unknown as { changes: number }
    return result.changes > 0
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

  function listUnexecuted(projectId: string): UnexecutedPlanRow[] {
    type RawUnexecutedRow = { project_id: string; session_id: string; content: string; updated_at: number }
    const rows = getUnexecutedStatements().rows.all(projectId) as RawUnexecutedRow[]
    return rows.map(row => ({
      projectId: row.project_id,
      sessionId: row.session_id,
      content: row.content,
      updatedAt: row.updated_at,
    }))
  }

  function unexecutedCountsByProject(): Map<string, number> {
    const rows = getUnexecutedStatements().counts.all() as { project_id: string; cnt: number }[]
    return new Map(rows.map(row => [row.project_id, row.cnt]))
  }

  function listLoopNames(projectId: string): string[] {
    return (stmtListLoopNames.all(projectId) as { loop_name: string }[]).map(r => r.loop_name)
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
    listUnexecuted,
    unexecutedCountsByProject,
    listLoopNames,
  }
}
