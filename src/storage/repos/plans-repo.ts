import type { Database, Statement } from 'bun:sqlite'
import { z } from 'zod'
import { statementChanges } from '../sqlite-open'

const planRowSchema = z.object({
  project_id: z.string(),
  loop_name: z.string().nullable(),
  session_id: z.string().nullable(),
  content: z.string(),
  updated_at: z.number(),
})
const planRowsSchema = z.array(planRowSchema)

const unexecutedPlanRowSchema = z.object({
  project_id: z.string(),
  session_id: z.string(),
  content: z.string(),
  updated_at: z.number(),
})
const unexecutedPlanRowsSchema = z.array(unexecutedPlanRowSchema)

const loopNameRowSchema = z.object({ loop_name: z.string() })
const loopNameRowsSchema = z.array(loopNameRowSchema)

const projectCountRowSchema = z.object({ project_id: z.string(), cnt: z.number() })
const projectCountRowsSchema = z.array(projectCountRowSchema)

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
  deleteForSession(projectId: string, sessionId: string): boolean
  deleteForLoop(projectId: string, loopName: string): void
  listRecent(projectId: string, opts?: ListRecentPlansOptions): PlanRow[]
  searchRecent(projectId: string, pattern: RegExp, opts?: ListRecentPlansOptions): PlanRow[]
  listUnexecuted(projectId: string): UnexecutedPlanRow[]
  unexecutedCountsByProject(): Map<string, number>
  listLoopNames(projectId: string): string[]
}

export function createPlansRepo(db: Database): PlansRepo {
  function mapRow(row: z.infer<typeof planRowSchema>): PlanRow {
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
    const row = planRowSchema.nullish().parse(stmtGetForSession.get(projectId, sessionId))
    if (!row) return null
    return mapRow(row)
  }

  function getForLoop(projectId: string, loopName: string): PlanRow | null {
    const row = planRowSchema.nullish().parse(stmtGetForLoop.get(projectId, loopName))
    if (!row) return null
    return mapRow(row)
  }

  function getForLoopOrSession(projectId: string, loopName: string, sessionId: string): PlanRow | null {
    return getForLoop(projectId, loopName) ?? getForSession(projectId, sessionId)
  }

  function promote(projectId: string, sessionId: string, loopName: string): boolean {
    return statementChanges(stmtPromote.run(loopName, projectId, sessionId)) > 0
  }

  function deleteForSession(projectId: string, sessionId: string): boolean {
    return statementChanges(stmtDeleteForSession.run(projectId, sessionId)) > 0
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
    return planRowsSchema.parse(stmtListRecent.all(projectId, limit)).map(mapRow)
  }

  function searchRecent(projectId: string, pattern: RegExp, opts?: ListRecentPlansOptions): PlanRow[] {
    const limit = clampLimit(opts?.limit, 20)
    const scanWindow = Math.max(limit * 5, 100)
    const rows = planRowsSchema.parse(stmtListRecent.all(projectId, scanWindow)).map(mapRow)
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
    const rows = unexecutedPlanRowsSchema.parse(getUnexecutedStatements().rows.all(projectId))
    return rows.map(row => ({
      projectId: row.project_id,
      sessionId: row.session_id,
      content: row.content,
      updatedAt: row.updated_at,
    }))
  }

  function unexecutedCountsByProject(): Map<string, number> {
    const rows = projectCountRowsSchema.parse(getUnexecutedStatements().counts.all())
    return new Map(rows.map(row => [row.project_id, row.cnt]))
  }

  function listLoopNames(projectId: string): string[] {
    return loopNameRowsSchema.parse(stmtListLoopNames.all(projectId)).map(r => r.loop_name)
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
