import type { Database } from 'bun:sqlite'

export interface GoalBriefRow {
  projectId: string
  sessionId: string
  content: string
  updatedAt: number
}

export interface GoalBriefsRepo {
  writeForSession(projectId: string, sessionId: string, content: string): void
  getForSession(projectId: string, sessionId: string): GoalBriefRow | null
  deleteForSession(projectId: string, sessionId: string): void
}

export function createGoalBriefsRepo(db: Database): GoalBriefsRepo {
  type RawRow = { project_id: string; session_id: string; content: string; updated_at: number }

  function mapRow(row: RawRow): GoalBriefRow {
    return {
      projectId: row.project_id,
      sessionId: row.session_id,
      content: row.content,
      updatedAt: row.updated_at,
    }
  }

  const stmtWriteForSession = db.prepare(`
    INSERT OR REPLACE INTO goal_briefs (project_id, session_id, content, updated_at)
    VALUES (?, ?, ?, ?)
  `)

  const stmtGetForSession = db.prepare(`
    SELECT project_id, session_id, content, updated_at
    FROM goal_briefs
    WHERE project_id = ? AND session_id = ?
  `)

  const stmtDeleteForSession = db.prepare(`
    DELETE FROM goal_briefs
    WHERE project_id = ? AND session_id = ?
  `)

  function writeForSession(projectId: string, sessionId: string, content: string): void {
    stmtWriteForSession.run(projectId, sessionId, content, Date.now())
  }

  function getForSession(projectId: string, sessionId: string): GoalBriefRow | null {
    const row = stmtGetForSession.get(projectId, sessionId) as RawRow | undefined
    if (!row) return null
    return mapRow(row)
  }

  function deleteForSession(projectId: string, sessionId: string): void {
    stmtDeleteForSession.run(projectId, sessionId)
  }

  return {
    writeForSession,
    getForSession,
    deleteForSession,
  }
}
