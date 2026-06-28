/**
 * Workspace removal with pending-teardown context.
 *
 * Sets the teardown context before calling workspace.remove so the adapter
 * can produce informative commit messages and honor doRemoveWorktree.
 */

import type { ForgeClient } from '../client/port'
import type { PendingTeardownRegistry } from './pending-teardown'
import type { Logger } from '../types'

export interface RemoveWithDeps {
  client: ForgeClient
  pendingTeardowns: PendingTeardownRegistry
  logger: Logger
}

export interface RemoveWithInput {
  workspaceId: string
  loopName: string
  action: 'remove-registration-only' | 'remove-fully'
  reasonLabel: string
}

export interface RemoveWithResult {
  ok: boolean
  error?: string
}

/**
 * Remove a forge workspace with proper teardown context.
 *
 * - Sets pendingTeardowns entry before calling workspace.remove
 * - doRemoveWorktree is true for 'remove-fully', false for 'remove-registration-only'
 * - doCommit is always false (sweep and attach safety-net don't commit)
 * - Clears the teardown entry in finally block
 */
export async function removeForgeWorkspaceWithContext(
  deps: RemoveWithDeps,
  input: RemoveWithInput,
): Promise<RemoveWithResult> {
  const { client, pendingTeardowns, logger } = deps
  const { workspaceId, loopName, action, reasonLabel } = input

  const doRemoveWorktree = action === 'remove-fully'
  const doCommit = false

  pendingTeardowns.set(loopName, {
    iteration: 0,
    reasonLabel,
    doCommit,
    doRemoveWorktree,
  })

  try {
    await client.workspace.remove({ id: workspaceId })
    logger.log(`[remove-with-context] removed workspace ${workspaceId} for loop ${loopName} (action=${action})`)
    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error(`[remove-with-context] workspace.remove threw for ${workspaceId}`, err)
    return { ok: false, error }
  } finally {
    pendingTeardowns.clear(loopName)
  }
}
