import { existsSync } from 'fs'
import { parseTerminationReasonString } from '../loop'

export interface RestartableLoopState {
  loopName: string
  status: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'
  terminationReason?: string | null
  worktree?: boolean
  worktreeDir?: string
  active: boolean
}

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

export function getRestartability(
  state: RestartableLoopState,
  opts?: { force?: boolean; worktreeExists?: (path: string) => boolean; branchExists?: () => boolean }
): RestartabilityResult {
  const worktreeExists = opts?.worktreeExists ?? existsSync
  
  if (state.status === 'completed') {
    return {
      restartable: false,
      restartRequiresForce: false,
      restartBlockedReason: 'completed',
      restartBlockedMessage: `Loop "${state.loopName}" completed successfully and cannot be restarted.`,
    }
  }
  
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
  
  if (state.worktree && state.worktreeDir && !worktreeExists(state.worktreeDir)) {
    if (!opts?.branchExists?.()) {
      return {
        restartable: false,
        restartRequiresForce: false,
        restartBlockedReason: 'missing_worktree',
        restartBlockedMessage: `Cannot restart "${state.loopName}": worktree directory no longer exists at ${state.worktreeDir} and its branch is gone.`,
      }
    }
  }
  
  if (state.active) {
    return {
      restartable: true,
      restartRequiresForce: true,
      restartBlockedReason: 'active_requires_force',
      restartBlockedMessage: `Loop "${state.loopName}" is currently active. Use force=true to force-restart a stuck loop.`,
    }
  }
  
  return {
    restartable: true,
    restartRequiresForce: false,
  }
}
