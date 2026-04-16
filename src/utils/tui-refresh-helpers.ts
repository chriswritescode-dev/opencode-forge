/**
 * TUI refresh helpers for reading loop states from KV.
 * 
 * This module provides testable helpers for accessing loop state
 * from the shared project KV store.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveDataDir } from '../storage'
import type { GraphStatusPayload } from './graph-status-store'

export type LoopInfo = {
  name: string
  phase: string
  iteration: number
  maxIterations: number
  sessionId: string
  active: boolean
  startedAt?: string
  completedAt?: string
  terminationReason?: string
  worktreeBranch?: string
  worktree?: boolean
  worktreeDir?: string
  executionModel?: string
  auditorModel?: string
}

/**
 * Gets the database path used by the memory plugin.
 * Exported for testing purposes.
 */
export function getDbPath(): string {
  return join(resolveDataDir(), 'graph.db')
}

/**
 * Reads loop states from the shared KV store.
 * 
 * @param projectId - The project ID (git commit hash)
 * @param dbPathOverride - Optional database path override (for testing)
 * @returns Array of loop states
 */
export function readLoopStates(projectId: string, dbPathOverride?: string): LoopInfo[] {
  const dbPath = dbPathOverride || getDbPath()
  
  if (!existsSync(dbPath)) return []
  
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const now = Date.now()
    const stmt = db.prepare('SELECT key, data FROM project_kv WHERE project_id = ? AND key LIKE ? AND expires_at > ?')
    const rows = stmt.all(projectId, 'loop:%', now) as Array<{ key: string; data: string }>
    
    const loops: LoopInfo[] = []
    for (const row of rows) {
      try {
        const state = JSON.parse(row.data)
        if (!state.loopName || !state.sessionId) continue
        loops.push({
          name: state.loopName,
          phase: state.phase ?? 'coding',
          iteration: state.iteration ?? 0,
          maxIterations: state.maxIterations ?? 0,
          sessionId: state.sessionId,
          active: state.active ?? false,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          terminationReason: state.terminationReason,
          worktreeBranch: state.worktreeBranch,
          worktree: state.worktree ?? false,
          worktreeDir: state.worktreeDir,
          executionModel: state.executionModel,
          auditorModel: state.auditorModel,
        })
      } catch {}
    }
    return loops
  } catch {
    return []
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Reads a single loop's current state by name from KV.
 * Used by LoopDetailsDialog to avoid stale snapshots.
 * 
 * @param projectId - The project ID (git commit hash)
 * @param loopName - The loop name to read
 * @param dbPathOverride - Optional database path override (for testing)
 * @returns The loop state or null if not found
 */
export function readLoopByName(projectId: string, loopName: string, dbPathOverride?: string): LoopInfo | null {
  const dbPath = dbPathOverride || getDbPath()
  
  if (!existsSync(dbPath)) return null
  
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const now = Date.now()
    const key = `loop:${loopName}`
    const row = db.prepare('SELECT data FROM project_kv WHERE project_id = ? AND key = ? AND expires_at > ?')
      .get(projectId, key, now) as { data: string } | null
    
    if (!row) return null
    
    const state = JSON.parse(row.data)
    if (!state.loopName || !state.sessionId) return null
    
    return {
      name: state.loopName,
      phase: state.phase ?? 'coding',
      iteration: state.iteration ?? 0,
      maxIterations: state.maxIterations ?? 0,
      sessionId: state.sessionId,
      active: state.active ?? false,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      terminationReason: state.terminationReason,
      worktreeBranch: state.worktreeBranch,
      worktree: state.worktree ?? false,
      worktreeDir: state.worktreeDir,
      executionModel: state.executionModel,
      auditorModel: state.auditorModel,
    }
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Computes whether the sidebar should poll for updates based on
 * active worktree loops and transient graph status.
 * 
 * Polling continues when:
 * - There is at least one active worktree loop, OR
 * - The graph status is in a transient state (initializing or indexing)
 * 
 * Polling stops when:
 * - No active worktree loops AND graph status is terminal (ready, error, unavailable)
 * 
 * @param loops - Array of loop states
 * @param graphStatus - Current graph status payload
 * @returns true if polling should continue, false otherwise
 */
export function shouldPollSidebar(
  loops: LoopInfo[],
  graphStatus: GraphStatusPayload | null
): boolean {
  const hasActiveWorktreeLoops = loops.some(l => l.active && l.worktree)
  const isGraphTransient = graphStatus !== null && 
    (graphStatus.state === 'initializing' || graphStatus.state === 'indexing')
  
  return hasActiveWorktreeLoops || isGraphTransient
}
