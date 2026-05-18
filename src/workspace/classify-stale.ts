/**
 * Classification logic for stale forge workspaces.
 *
 * Shared by:
 * - sweep-stale.ts (opportunistic sweep on loop teardown)
 * - forge-session-attach.ts (safety-net on session attach)
 *
 * The decision rule is identical for both triggers.
 */

import type { LoopsRepo } from '../storage/repos/loops-repo'

export interface ForgeWorkspaceEntry {
  id: string
  type?: string | null
  extra?: Record<string, unknown> | null
}

export type ClassifyAction =
  | { action: 'keep'; reason: 'running' | 'not-forge' | 'no-loop-name' | 'no-project-directory' | 'wrong-project' }
  | { action: 'remove-registration-only'; reason: 'restartable-terminal'; loopName: string }
  | { action: 'remove-fully'; reason: 'completed' | 'missing-row'; loopName: string }

/**
 * Classify a forge workspace entry to determine the appropriate action.
 *
 * Decision tree:
 * 1. type !== 'forge' → keep/not-forge
 * 2. missing forgeLoop.loopName → keep/no-loop-name
 * 3. missing extra.projectDirectory → keep/no-project-directory
 * 4. projectDirectory mismatch → keep/wrong-project
 * 5. loopsRepo.get returns null → remove-fully/missing-row
 * 6. loop status === 'running' → keep/running
 * 7. loop status === 'completed' → remove-fully/completed
 * 8. loop status in ['cancelled', 'errored', 'stalled'] → remove-registration-only/restartable-terminal
 */
export function classifyForgeWorkspace(
  entry: ForgeWorkspaceEntry,
  loopsRepo: LoopsRepo,
  projectId: string,
  projectDirectory: string,
): ClassifyAction {
  // Check 1: must be a forge workspace
  if (entry.type !== 'forge') {
    return { action: 'keep', reason: 'not-forge' }
  }

  // Check 2: must have forgeLoop.loopName
  const forgeLoop = (entry.extra?.forgeLoop ?? {}) as { loopName?: unknown }
  const loopName = typeof forgeLoop.loopName === 'string' ? forgeLoop.loopName : undefined
  if (!loopName) {
    return { action: 'keep', reason: 'no-loop-name' }
  }

  // Check 3: must have extra.projectDirectory
  const wsProjectDir = (entry.extra?.projectDirectory ?? {}) as string | undefined
  if (!wsProjectDir || typeof wsProjectDir !== 'string') {
    return { action: 'keep', reason: 'no-project-directory' }
  }

  // Check 4: projectDirectory must match
  if (wsProjectDir !== projectDirectory) {
    return { action: 'keep', reason: 'wrong-project' }
  }

  // Check 5: look up loop row
  const row = loopsRepo.get(projectId, loopName)
  if (!row) {
    return { action: 'remove-fully', reason: 'missing-row', loopName }
  }

  // Check 6: running loops are kept (legitimate recovery case)
  if (row.status === 'running') {
    return { action: 'keep', reason: 'running' }
  }

  // Check 7: completed loops are fully removed
  if (row.status === 'completed') {
    return { action: 'remove-fully', reason: 'completed', loopName }
  }

  // Check 8: restartable terminal statuses (cancelled, errored, stalled)
  // Remove registration only, preserve worktree for manual restart
  if (row.status === 'cancelled' || row.status === 'errored' || row.status === 'stalled') {
    return { action: 'remove-registration-only', reason: 'restartable-terminal', loopName }
  }

  // Fallback: should not reach here, but treat as keep to be safe
  return { action: 'keep', reason: 'running' }
}
