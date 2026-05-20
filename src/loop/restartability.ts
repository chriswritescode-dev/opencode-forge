/**
 * Shared restartability logic for determining if a loop can be restarted.
 * Used by both execution service and tooling/display layers.
 */

import { existsSync } from 'fs'
import type { LoopState } from '../loop/state'
import { parseTerminationReasonString } from '../loop'

export type RestartBlockedReason =
  | 'completed'
  | 'missing_worktree'
  | 'active_requires_force'

export interface RestartabilityResult {
  restartable: boolean
  restartRequiresForce: boolean
  restartBlockedReason?: RestartBlockedReason
  restartBlockedMessage?: string
}

/**
 * Determine if a loop can be restarted based on its state.
 * 
 * Rules:
 * - Completed loops cannot restart (checked by status field and terminationReason)
 * - Missing worktree blocks restart
 * - Active/running loops require force
 * - All other terminal states (cancelled, errored, stalled) are restartable without force
 */
export function getRestartability(
  state: LoopState,
  opts?: { force?: boolean; worktreeExists?: (path: string) => boolean }
): RestartabilityResult {
  const worktreeExists = opts?.worktreeExists ?? existsSync
  
  // Completed loops cannot restart - check persisted status first
  if (state.status === 'completed') {
    return {
      restartable: false,
      restartRequiresForce: false,
      restartBlockedReason: 'completed',
      restartBlockedMessage: `Loop "${state.loopName}" completed successfully and cannot be restarted.`,
    }
  }
  
  // Also check terminationReason for legacy/secondary validation
  if (state.terminationReason) {
    const parsed = parseTerminationReasonString(state.terminationReason)
    if (parsed.kind === 'completed') {
      return {
        restartable: false,
        restartRequiresForce: false,
        restartBlockedReason: 'completed',
        restartBlockedMessage: `Loop "${state.loopName}" completed successfully and cannot be restarted.`,
      }
    }
  }
  
  // Missing worktree blocks restart
  if (state.worktree && state.worktreeDir && !worktreeExists(state.worktreeDir)) {
    return {
      restartable: false,
      restartRequiresForce: false,
      restartBlockedReason: 'missing_worktree',
      restartBlockedMessage: `Cannot restart "${state.loopName}": worktree directory no longer exists at ${state.worktreeDir}.`,
    }
  }
  
  // Active/running loops require force
  if (state.active) {
    return {
      restartable: true,
      restartRequiresForce: true,
      restartBlockedReason: 'active_requires_force',
      restartBlockedMessage: `Loop "${state.loopName}" is currently active. Use force=true to force-restart a stuck loop.`,
    }
  }
  
  // All other terminal states (cancelled, errored, stalled) are restartable without force
  return {
    restartable: true,
    restartRequiresForce: false,
  }
}
