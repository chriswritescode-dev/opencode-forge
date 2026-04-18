/**
 * Sandbox reconciliation module for periodic container lifecycle management.
 * 
 * This module provides a reconciliation function that ensures sandbox containers
 * are started/restored for loops that have sandbox enabled but no active container.
 * It is designed to be called periodically from the plugin server.
 */

import type { SandboxManager } from './manager'
import type { LoopService } from '../services/loop'
import type { Logger } from '../types'

export interface ReconcileSandboxesDeps {
  sandboxManager: SandboxManager
  loopService: LoopService
  logger: Logger
}

// Per-deps re-entrancy guard. Using a WeakMap keyed on the deps object ensures
// independent plugin instances (or independent test contexts) do not block each other.
const inFlightByDeps = new WeakMap<ReconcileSandboxesDeps, boolean>()

/**
 * Reconciles sandbox containers with loop states.
 * 
 * This function iterates through all active loops and ensures that:
 * 1. Loops with sandbox enabled have an active container
 * 2. Container names are persisted in loop state
 * 3. Stale container references are restored
 * 
 * The function includes a re-entrancy guard to prevent concurrent executions.
 * 
 * @param deps - Dependencies including sandbox manager, loop service, and logger
 * @returns Promise that resolves when reconciliation is complete
 */
export async function reconcileSandboxes(deps: ReconcileSandboxesDeps): Promise<void> {
  const { sandboxManager, loopService, logger } = deps

  if (inFlightByDeps.get(deps)) {
    // Another reconciliation is already in progress for this deps, return early
    return
  }

  inFlightByDeps.set(deps, true)

  try {
    const activeLoops = loopService.listActive()

    for (const state of activeLoops) {
      // Only process loops with sandbox enabled, worktree mode, and a worktree directory.
      // In-place (non-worktree) loops never use a sandbox container even if sandbox=true
      // is persisted in state, so skip them to avoid starting unused containers.
      if (state.sandbox !== true || state.worktree !== true || !state.worktreeDir || !state.loopName) {
        continue
      }

      try {
        const loopName = state.loopName

        // Case 1: Container is already active - ensure the persisted container name
        // matches the manager's view. This covers both "missing" and "stale/mismatched"
        // names (e.g. after a crash between manager start and state write).
        if (sandboxManager.isActive(loopName)) {
          const active = sandboxManager.getActive(loopName)
          if (active && state.sandboxContainer !== active.containerName) {
            loopService.setSandboxContainer(loopName, active.containerName)
            const action = state.sandboxContainer ? 'corrected' : 'backfilled'
            logger.log(`Sandbox reconcile: ${action} container name for ${loopName}`)
          }
          continue
        }

        // Case 2: Container name exists but container is not active - restore
        if (state.sandboxContainer && state.sandboxContainer.length > 0) {
          await sandboxManager.restore(loopName, state.worktreeDir, state.startedAt)
          logger.log(`Sandbox reconcile: restored container for ${loopName}`)
          continue
        }

        // Case 3: No container name - start fresh
        const result = await sandboxManager.start(loopName, state.worktreeDir, state.startedAt)
        loopService.setSandboxContainer(loopName, result.containerName)
        logger.log(`Sandbox reconcile: started container for ${loopName}`)
      } catch (err) {
        // Log error but continue processing other loops
        logger.error(`Sandbox reconcile: failed for ${state.loopName}`, err)
      }
    }
  } finally {
    inFlightByDeps.set(deps, false)
  }
}
