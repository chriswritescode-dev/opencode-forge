import type { Database } from 'bun:sqlite'

export interface PlanRow {
  projectId: string
  loopName: string | null
  sessionId: string | null
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
  deleteForSession(projectId: string, sessionId: string): void
  deleteForLoop(projectId: string, loopName: string): void
}

export function createPlansRepo(db: Database): PlansRepo {
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

  function writeForSession(projectId: string, sessionId: string, content: string): void {
    stmtWriteForSession.run(projectId, sessionId, content, Date.now())
  }

  function writeForLoop(projectId: string, loopName: string, content: string): void {
    stmtWriteForLoop.run(projectId, loopName, content, Date.now())
  }

  function getForSession(projectId: string, sessionId: string): PlanRow | null {
    const row = stmtGetForSession.get(projectId, sessionId) as
      | { project_id: string; loop_name: string | null; session_id: string | null; content: string; updated_at: number }
      | undefined
    if (!row) return null
    return {
      projectId: row.project_id,
      loopName: row.loop_name,
      sessionId: row.session_id,
      content: row.content,
      updatedAt: row.updated_at,
    }
  }

  function getForLoop(projectId: string, loopName: string): PlanRow | null {
    const row = stmtGetForLoop.get(projectId, loopName) as
      | { project_id: string; loop_name: string | null; session_id: string | null; content: string; updated_at: number }
      | undefined
    if (!row) return null
    return {
      projectId: row.project_id,
      loopName: row.loop_name,
      sessionId: row.session_id,
      content: row.content,
      updatedAt: row.updated_at,
    }
  }

  function getForLoopOrSession(projectId: string, loopName: string, sessionId: string): PlanRow | null {
    return getForLoop(projectId, loopName) ?? getForSession(projectId, sessionId)
  }

  function promote(projectId: string, sessionId: string, loopName: string): boolean {
    const result = stmtPromote.run(loopName, projectId, sessionId)
    return result.changes > 0
  }

  function deleteForSession(projectId: string, sessionId: string): void {
    stmtDeleteForSession.run(projectId, sessionId)
  }

  function deleteForLoop(projectId: string, loopName: string): void {
    stmtDeleteForLoop.run(projectId, loopName)
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
  }
}
