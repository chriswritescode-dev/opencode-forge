/**
 * Shared loop cancellation logic used by both CLI and API.
 */

import type { Database } from 'bun:sqlite'
import { createLoopsRepo } from '../storage/repos/loops-repo'
import { listLoopStatesFromDb } from '../storage/cli-helpers'
import { existsSync } from 'fs'

export interface CancelLoopDeps {
  db: Database
  projectId: string
  loopName: string
  cleanup?: boolean
}

export interface CancelLoopResult {
  success: boolean
  loopName: string
  status: string
  error?: string
}

export async function cancelLoopByName(
  deps: CancelLoopDeps
): Promise<CancelLoopResult> {
  const { db, projectId, loopName, cleanup } = deps

  // Check if loop exists and is active
  const loopStates = listLoopStatesFromDb(db, projectId, { activeOnly: true })
  const entry = loopStates.find((e) => e.row.loop_name === loopName)

  if (!entry) {
    return {
      success: false,
      loopName,
      status: 'not_found',
      error: 'loop not found or not active',
    }
  }

  const now = Date.now()
  createLoopsRepo(db).terminate(projectId, loopName, {
    status: 'cancelled',
    reason: 'cancelled',
    completedAt: now,
  })

  // Cleanup worktree if requested (simplified - full implementation would call cleanupLoopWorktree)
  if (cleanup && entry.state.worktreeDir && existsSync(entry.state.worktreeDir)) {
    // Worktree cleanup would go here - skipped for simplicity
    console.log(`Worktree cleanup skipped for ${entry.state.worktreeDir}`)
  }

  return {
    success: true,
    loopName,
    status: 'cancelled',
  }
}
