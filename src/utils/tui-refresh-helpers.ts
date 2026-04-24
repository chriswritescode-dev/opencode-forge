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
  workspaceId?: string
  hostSessionId?: string
}

/**
 * Gets the database path used by the memory plugin.
 * Exported for testing purposes.
 */
function getDbPath(): string {
  return join(resolveDataDir(), 'graph.db')
}

/**
 * Reads loop states from the loops table.
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
    const stmt = db.prepare(`
      SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir,
             worktree_branch, project_dir, max_iterations, iteration, audit_count,
             error_count, phase, execution_model, auditor_model,
             model_failed, sandbox, sandbox_container, started_at, completed_at,
             termination_reason, completion_summary, workspace_id, host_session_id
      FROM loops
      WHERE project_id = ?
      ORDER BY started_at DESC
    `)
    const rows = stmt.all(projectId) as Array<{
      project_id: string
      loop_name: string
      status: string
      current_session_id: string
      worktree: number
      worktree_dir: string
      worktree_branch: string | null
      project_dir: string
      max_iterations: number
      iteration: number
      audit_count: number
      error_count: number
      phase: string
      execution_model: string | null
      auditor_model: string | null
      model_failed: number
      sandbox: number
      sandbox_container: string | null
      started_at: number
      completed_at: number | null
      termination_reason: string | null
      completion_summary: string | null
      workspace_id: string | null
      host_session_id: string | null
    }>
    
    const loops: LoopInfo[] = []
    for (const row of rows) {
      loops.push({
        name: row.loop_name,
        phase: row.phase as 'coding' | 'auditing',
        iteration: row.iteration,
        maxIterations: row.max_iterations,
        sessionId: row.current_session_id,
        active: row.status === 'running',
        startedAt: new Date(row.started_at).toISOString(),
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
        terminationReason: row.termination_reason ?? undefined,
        worktreeBranch: row.worktree_branch ?? undefined,
        worktree: row.worktree === 1,
        worktreeDir: row.worktree_dir,
        executionModel: row.execution_model ?? undefined,
        auditorModel: row.auditor_model ?? undefined,
        workspaceId: row.workspace_id ?? undefined,
        hostSessionId: row.host_session_id ?? undefined,
      })
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
    const row = db.prepare(`
      SELECT project_id, loop_name, status, current_session_id, worktree, worktree_dir,
             worktree_branch, project_dir, max_iterations, iteration, audit_count,
             error_count, phase, execution_model, auditor_model,
             model_failed, sandbox, sandbox_container, started_at, completed_at,
             termination_reason, completion_summary, workspace_id, host_session_id
      FROM loops
      WHERE project_id = ? AND loop_name = ?
    `).get(projectId, loopName) as {
      project_id: string
      loop_name: string
      status: string
      current_session_id: string
      worktree: number
      worktree_dir: string
      worktree_branch: string | null
      project_dir: string
      max_iterations: number
      iteration: number
      audit_count: number
      error_count: number
      phase: string
      execution_model: string | null
      auditor_model: string | null
      model_failed: number
      sandbox: number
      sandbox_container: string | null
      started_at: number
      completed_at: number | null
      termination_reason: string | null
      completion_summary: string | null
      workspace_id: string | null
      host_session_id: string | null
    } | null
    
    if (!row) return null
    
    return {
      name: row.loop_name,
      phase: row.phase as 'coding' | 'auditing',
      iteration: row.iteration,
      maxIterations: row.max_iterations,
      sessionId: row.current_session_id,
      active: row.status === 'running',
      startedAt: new Date(row.started_at).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
      terminationReason: row.termination_reason ?? undefined,
      worktreeBranch: row.worktree_branch ?? undefined,
      worktree: row.worktree === 1,
      worktreeDir: row.worktree_dir,
      executionModel: row.execution_model ?? undefined,
      auditorModel: row.auditor_model ?? undefined,
      workspaceId: row.workspace_id ?? undefined,
      hostSessionId: row.host_session_id ?? undefined,
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
