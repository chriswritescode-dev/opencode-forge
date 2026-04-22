/**
 * Shared loop restart logic used by both CLI and API.
 */

import type { Database } from 'bun:sqlite'
import { listLoopStatesFromDb } from '../storage/cli-helpers'

export interface RestartLoopDeps {
  db: Database
  projectId: string
  loopName: string
  force?: boolean
}

export interface RestartLoopResult {
  success: boolean
  loopName: string
  status: string
  sessionId?: string
  error?: string
}

export async function restartLoopByName(
  deps: RestartLoopDeps
): Promise<RestartLoopResult> {
  const { db, projectId, loopName, force } = deps

  // Check if loop exists
  const loopStates = listLoopStatesFromDb(db, projectId)
  const entry = loopStates.find((e) => e.row.loop_name === loopName)

  if (!entry) {
    return {
      success: false,
      loopName,
      status: 'not_found',
      error: 'loop not found',
    }
  }

  // Check if loop is completed (cannot restart)
  if (entry.state.terminationReason === 'completed') {
    return {
      success: false,
      loopName,
      status: 'completed',
      error: 'completed loops cannot be restarted',
    }
  }

  // If active and not forced, return conflict
  if (entry.state.active && !force) {
    return {
      success: false,
      loopName,
      status: 'conflict',
      error: 'loop is already active',
    }
  }

  // For now, return a simplified response
  // Full implementation would mirror the CLI restart logic
  return {
    success: true,
    loopName,
    status: 'restarting',
  }
}
