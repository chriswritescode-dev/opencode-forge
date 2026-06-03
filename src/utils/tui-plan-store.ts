/**
 * TUI-side persisted plan store access.
 *
 * Opens the Forge SQLite database read-only (and read-write for mutations)
 * to read/write plan data directly, mirroring the server-side PlansRepo
 * access pattern. This allows the TUI to retrieve a server-captured plan
 * without parsing chat messages.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveDataDir } from '../storage'
import { createPlansRepo } from '../storage/repos/plans-repo'

function getDbPath(): string {
  return join(resolveDataDir(), 'forge.db')
}

/**
 * Read the persisted plan for a specific project + session.
 * Returns the plan content, or null if none exists.
 */
export function readPlan(projectId: string, sessionId: string): string | null {
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const plansRepo = createPlansRepo(db)
    const row = plansRepo.getForSession(projectId, sessionId)
    return row?.content ?? null
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Read the persisted plan for a session across all projects.
 * Returns the content and projectId, or null.
 *
 * Uses a direct SQL query because the PlansRepo interface is scoped
 * to a single projectId.
 */
export function readPlanForAnyProject(sessionId: string): { projectId: string; content: string } | null {
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const stmt = db.prepare(
      'SELECT project_id, content FROM plans WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1'
    )
    const row = stmt.get(sessionId) as { project_id: string; content: string } | undefined
    if (!row) return null
    return { projectId: row.project_id, content: row.content }
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Write a plan for a specific project + session.
 */
export function writePlan(projectId: string, sessionId: string, content: string): void {
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) return

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    const plansRepo = createPlansRepo(db)
    plansRepo.writeForSession(projectId, sessionId, content)
  } catch {
    // silently fail
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Delete a plan for a specific project + session.
 */
export function deletePlan(projectId: string, sessionId: string): void {
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) return

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    const plansRepo = createPlansRepo(db)
    plansRepo.deleteForSession(projectId, sessionId)
  } catch {
    // silently fail
  } finally {
    try { db?.close() } catch {}
  }
}
