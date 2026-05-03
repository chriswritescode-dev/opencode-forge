/**
 * TUI plan store helper for resolving plan keys with loop-session awareness.
 *
 * This module provides plan reading with session → loop resolution.
 * Reads prefer loop_large_fields.prompt (execution store), then fall back to
 * the plans table.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveDataDir } from '../storage'
import { createPlansRepo } from '../storage/repos/plans-repo'
import { createLoopsRepo } from '../storage/repos/loops-repo'

/**
 * Gets the database path used by the memory plugin.
 * Exported for testing purposes.
 */
function getDbPath(): string {
  return join(resolveDataDir(), 'forge.db')
}

/**
 * Resolves the loop name for a session by checking the loops table.
 * 
 * @param db - Database instance
 * @param projectId - The project ID
 * @param sessionID - The session ID to resolve
 * @returns The loop name or null if not found
 */
function resolveLoopNameForSession(db: Database, projectId: string, sessionID: string): string | null {
  const loopsRepo = createLoopsRepo(db)
  const row = loopsRepo.getBySessionId(projectId, sessionID)
  return row?.loopName ?? null
}

/**
 * Reads plan content from the plans table for a session.
 * 
 * @param projectId - The project ID (git commit hash)
 * @param sessionID - The session ID to read plan for
 * @param dbPathOverride - Optional database path override (for testing)
 * @returns The plan content or null if not found
 */
export function readPlan(projectId: string, sessionID: string, dbPathOverride?: string): string | null {
  const dbPath = dbPathOverride || getDbPath()

  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const plansRepo = createPlansRepo(db)
    const loopsRepo = createLoopsRepo(db)
    
    // Try loop-bound plan first (if session maps to a loop)
    const loopName = resolveLoopNameForSession(db, projectId, sessionID)
    if (loopName) {
      // Check loop_large_fields.prompt first (execution store), then plans table
      const fromExecution = loopsRepo.getLarge(projectId, loopName)?.prompt
      if (fromExecution) return fromExecution
      
      const planRow = plansRepo.getForLoop(projectId, loopName)
      if (planRow) return planRow.content
    }
    
    // Fall back to session-scoped plan
    const planRow = plansRepo.getForSession(projectId, sessionID)
    return planRow?.content ?? null
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

export function readPlanForAnyProject(sessionID: string, dbPathOverride?: string): string | null {
  const dbPath = dbPathOverride || getDbPath()

  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const rows = db.prepare(`
      SELECT project_id
      FROM plans
      WHERE session_id = ?
      ORDER BY updated_at DESC
    `).all(sessionID) as Array<{ project_id: string }>

    for (const row of rows) {
      const content = readPlan(row.project_id, sessionID, dbPath)
      if (content) return content
    }

    return null
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}


