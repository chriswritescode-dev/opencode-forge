/**
 * TUI graph status helper for reading persisted graph state.
 * 
 * This module provides read helpers for accessing graph service status
 * from the shared project KV store, following the same pattern as
 * src/utils/tui-plan-store.ts.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import type { GraphStatusPayload } from './graph-status-store'
import { resolveDataDir } from '../storage'

/**
 * Gets the database path used by the memory plugin.
 * Exported for testing purposes.
 */
export function getDbPath(): string {
  return join(resolveDataDir(), 'graph.db')
}

/**
 * Gets the database path for a specific data directory.
 * Exported for testing purposes.
 */
export function getDbPathForDataDir(dataDir: string): string {
  return join(dataDir, 'graph.db')
}

/**
 * Reads graph status from the shared KV store.
 * 
 * @param projectId - The project ID (git commit hash)
 * @param dbPathOverride - Optional database path override (for testing)
 * @returns The graph status payload or null if not found
 */
export function readGraphStatus(projectId: string, dbPathOverride?: string): GraphStatusPayload | null {
  const dbPath = dbPathOverride || getDbPath()

  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const now = Date.now()
    
    const row = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key = ? AND expires_at > ?'
    ).get(projectId, 'graph:status', now) as { data: string } | null

    if (!row) return null
    
    try {
      return JSON.parse(row.data) as GraphStatusPayload
    } catch {
      return null
    }
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Determines if the current graph status is still in-flight (transient).
 * Transient states indicate the graph is still being built and should
 * trigger continued sidebar refresh polling.
 * 
 * Terminal states (ready, error, unavailable, null) do not require
 * continued polling unless there are active worktree loops.
 * 
 * @param status - The graph status payload or null
 * @returns true if status is initializing or indexing, false otherwise
 */
export function isTransient(status: GraphStatusPayload | null): boolean {
  if (!status) return false
  return status.state === 'initializing' || status.state === 'indexing'
}

/**
 * Formats graph status for display in the TUI sidebar.
 * Returns the state text and color based solely on the persisted graph state.
 * 
 * @param status - The graph status payload
 * @returns Formatted display with state text and color
 */
export function formatGraphStatus(status: GraphStatusPayload | null): {
  text: string
  color: 'success' | 'info' | 'warning' | 'error' | 'textMuted'
} {
  if (!status) {
    return { text: 'unavailable', color: 'textMuted' }
  }

  switch (status.state) {
    case 'ready':
      if (status.stats) {
        return { 
          text: `ready · ${status.stats.files} files`, 
          color: 'success'
        }
      }
      return { 
        text: 'ready', 
        color: 'success'
      }
    
    case 'indexing':
      return { text: status.message || 'indexing', color: 'warning' }
    
    case 'initializing':
      return { text: 'initializing', color: 'info' }
    
    case 'error':
      return { text: 'error', color: 'error' }
    
    case 'unavailable':
    default:
      return { text: 'unavailable', color: 'textMuted' }
  }
}
