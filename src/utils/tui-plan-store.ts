/**
 * TUI plan store helper for resolving plan keys with loop-session awareness.
 * 
 * This module provides plan key resolution that mirrors the tool-side
 * convention in src/tools/plan-kv.ts:9-15, ensuring TUI plan access
 * honors loop worktree-scoped plan keys.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveDataDir } from '../storage'

/**
 * Gets the database path used by the memory plugin.
 * Exported for testing purposes.
 */
export function getDbPath(): string {
  return join(resolveDataDir(), 'graph.db')
}

/**
 * Resolves the plan key for a session, checking for loop-session mapping first.
 * 
 * Loop sessions store their plan under plan:{worktreeName}, while normal
 * sessions use plan:{sessionId}. This function checks for a loop-session
 * mapping and returns the appropriate plan key.
 * 
 * @param projectId - The project ID (git commit hash)
 * @param sessionID - The session ID to resolve
 * @param dbPathOverride - Optional database path override (for testing)
 * @returns The resolved plan key (either plan:{worktreeName} or plan:{sessionID})
 */
export function resolvePlanKey(projectId: string, sessionID: string, dbPathOverride?: string): string {
  const dbPath = dbPathOverride || getDbPath()

  if (!existsSync(dbPath)) {
    return `plan:${sessionID}`
  }

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const now = Date.now()
    
    // Check for loop-session mapping first
    const mappingRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key = ? AND expires_at > ?'
    ).get(projectId, `loop-session:${sessionID}`, now) as { data: string } | null

    if (mappingRow) {
      try {
        const worktreeName = JSON.parse(mappingRow.data)
        if (typeof worktreeName === 'string' && worktreeName) {
          return `plan:${worktreeName}`
        }
      } catch {
        // Fall through to default if JSON parse fails
      }
    }
  } catch {
    // Fall through to default on DB errors
  } finally {
    try { db?.close() } catch {}
  }

  // Default to session-based key for non-loop sessions
  return `plan:${sessionID}`
}

/**
 * Reads plan content from the KV store for a session.
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
    const now = Date.now()
    
    const planKey = resolvePlanKey(projectId, sessionID, dbPath)
    const row = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key = ? AND expires_at > ?'
    ).get(projectId, planKey, now) as { data: string } | null

    if (!row) return null
    const data = row.data
    if (typeof data === 'string' && data.startsWith('"')) {
      try { return JSON.parse(data) } catch { return data }
    }
    return data
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Writes plan content to the KV store for a session.
 * 
 * @param projectId - The project ID (git commit hash)
 * @param sessionID - The session ID to write plan for
 * @param content - The plan content to write
 * @param dbPathOverride - Optional database path override (for testing)
 * @returns true if successful, false otherwise
 */
export function writePlan(projectId: string, sessionID: string, content: string, dbPathOverride?: string): boolean {
  const dbPath = dbPathOverride || getDbPath()

  if (!existsSync(dbPath)) return false

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    const now = Date.now()
    const ttl = 7 * 24 * 60 * 60 * 1000
    
    const planKey = resolvePlanKey(projectId, sessionID, dbPath)
    db.prepare(
      'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(projectId, planKey, JSON.stringify(content), now + ttl, now, now)
    return true
  } catch {
    return false
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Deletes plan content from the KV store for a session.
 * 
 * @param projectId - The project ID (git commit hash)
 * @param sessionID - The session ID to delete plan for
 * @param dbPathOverride - Optional database path override (for testing)
 * @returns true if a row was deleted, false otherwise
 */
export function deletePlan(projectId: string, sessionID: string, dbPathOverride?: string): boolean {
  const dbPath = dbPathOverride || getDbPath()

  if (!existsSync(dbPath)) return false

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    
    const planKey = resolvePlanKey(projectId, sessionID, dbPath)
    const result = db.prepare(
      'DELETE FROM project_kv WHERE project_id = ? AND key = ?'
    ).run(projectId, planKey)
    
    return (result.changes || 0) > 0
  } catch {
    return false
  } finally {
    try { db?.close() } catch {}
  }
}
