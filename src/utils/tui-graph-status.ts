/**
 * TUI graph status helper for reading persisted graph state.
 * 
 * This module provides read helpers for accessing graph service status
 * from the graph_status table via GraphStatusRepo.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import type { GraphStatusPayload } from './graph-status-store'
import { isGraphReady, isGraphTransient } from './graph-status-store'
import { resolveDataDir } from '../storage'
import { createGraphStatusRepo } from '../storage/repos/graph-status-repo'

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
 * Reads graph status from the graph_status table.
 * 
 * @param projectId - The project ID (git commit hash)
 * @param dbPathOverride - Optional database path override (for testing)
 * @param cwd - Optional working directory scope for worktree sessions
 * @returns The graph status payload or null if not found
 */
export function readGraphStatus(projectId: string, dbPathOverride?: string, cwd?: string): GraphStatusPayload | null {
  const dbPath = dbPathOverride || getDbPath()

  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const repo = createGraphStatusRepo(db)
    const row = repo.read(projectId, cwd ?? '')
    
    if (!row) return null
    
    return {
      state: row.state,
      ready: row.ready,
      stats: row.stats ?? undefined,
      message: row.message ?? undefined,
      updatedAt: row.updatedAt,
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
  return isGraphTransient(status)
}

/**
 * Waits for graph readiness with a bounded timeout.
 * 
 * This function polls the graph status for a specific scope (projectId + cwd)
 * and resolves when the graph becomes ready or times out. It handles transient
 * states (initializing/indexing) by continuing to poll, but will not block
 * forever on missing/error/unavailable status.
 * 
 * @param projectId - The project ID
 * @param options - Wait options including db path, cwd scope, and timing
 * @returns Promise resolving to the final status or 'timeout'
 */
export async function waitForGraphReady(
  projectId: string,
  options?: {
    dbPathOverride?: string
    cwd?: string
    pollMs?: number
    timeoutMs?: number
  }
): Promise<GraphStatusPayload | 'timeout' | null> {
  const pollMs = options?.pollMs ?? 100
  const timeoutMs = options?.timeoutMs ?? 30000
  const startTime = Date.now()
  const missingStatusTimeout = 2000 // Short timeout for missing status (graph service may not have initialized yet)
  
  while (true) {
    const status = readGraphStatus(projectId, options?.dbPathOverride, options?.cwd)
    
    // Return immediately if ready
    if (isGraphReady(status)) {
      return status
    }
    
    // If status is missing, use a shorter timeout to avoid waiting forever
    // This handles the case where graph service hasn't written status yet
    if (!status) {
      if (Date.now() - startTime > missingStatusTimeout) {
        return null
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
      continue
    }
    
    // Check overall timeout after handling missing status
    if (Date.now() - startTime > timeoutMs) {
      return 'timeout'
    }
    
    // Stop polling if status is error or unavailable (not transient)
    if (status.state === 'error' || status.state === 'unavailable') {
      return status
    }
    
    // Continue polling while in transient state
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
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
