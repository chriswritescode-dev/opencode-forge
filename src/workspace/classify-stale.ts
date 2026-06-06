/**
 * Classification logic for stale forge workspaces.
 *
 * Shared by:
 * - sweep-stale.ts (opportunistic sweep on loop teardown)
 * - forge-session-attach.ts (safety-net on session attach)
 *
 * Pending attach workspaces are kept only while they are inside the attach grace window.
 */

import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { ForgeWorkspaceEntry } from './forge-worktree'
import { getForgeWorkspaceLoopName } from './forge-worktree'

const PENDING_ATTACH_GRACE_MS = 5 * 60 * 1000

export type ClassifyAction =
  | { action: 'keep'; reason: 'running' | 'pending-attach' | 'pending-start' | 'not-forge' | 'no-loop-name' | 'no-project-directory' | 'wrong-project' }
  | { action: 'remove-registration-only'; reason: 'restartable'; loopName: string }
  | { action: 'remove-fully'; reason: 'completed' | 'missing-row'; loopName: string }

export interface ClassifyForgeWorkspaceOptions {
  nowMs?: number
  pendingAttachGraceMs?: number
}

export function isPendingAttachWorkspace(
  entry: ForgeWorkspaceEntry,
  options: ClassifyForgeWorkspaceOptions = {},
): boolean {
  const forgeLoop = entry.extra?.forgeLoop
  if (!forgeLoop || typeof forgeLoop !== 'object') return false

  const metadata = forgeLoop as { initialPromptOwner?: unknown; pendingAttachStartedAt?: unknown }
  if (metadata.initialPromptOwner !== 'tui') return false

  const startedAt = metadata.pendingAttachStartedAt
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return false

  const nowMs = options.nowMs ?? Date.now()
  const graceMs = options.pendingAttachGraceMs ?? PENDING_ATTACH_GRACE_MS
  return nowMs - startedAt <= graceMs
}

function isPendingStartWorkspace(
  entry: ForgeWorkspaceEntry,
  options: ClassifyForgeWorkspaceOptions = {},
): boolean {
  const startedAt = entry.extra?.workspaceCreatedAt
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return false

  const nowMs = options.nowMs ?? Date.now()
  const graceMs = options.pendingAttachGraceMs ?? PENDING_ATTACH_GRACE_MS
  return nowMs - startedAt <= graceMs
}

/**
 * Classify a forge workspace entry to determine the appropriate action.
 *
 * Decision tree:
 * 1. type !== 'forge' → keep/not-forge
 * 2. missing extra.loopName → keep/no-loop-name
 * 3. missing extra.projectDirectory → keep/no-project-directory
 * 4. projectDirectory mismatch → keep/wrong-project
 * 5. loopsRepo.get returns null and pending attach grace is active → keep/pending-attach
 * 6. loopsRepo.get returns null and workspace creation grace is active → keep/pending-start
 * 7. loopsRepo.get returns null → remove-fully/missing-row
 * 8. loop status === 'running' → keep/running
 * 9. loop status === 'completed' → remove-fully/completed
 * 10. loop status in ['cancelled', 'errored', 'stalled'] → remove-registration-only/restartable
 */
export function classifyForgeWorkspace(
  entry: ForgeWorkspaceEntry,
  loopsRepo: LoopsRepo,
  projectId: string,
  projectDirectory: string,
  options: ClassifyForgeWorkspaceOptions = {},
): ClassifyAction {
  // Check 1: must be a forge workspace
  if (entry.type !== 'forge') {
    return { action: 'keep', reason: 'not-forge' }
  }

  // Check 2: must have extra.loopName
  const loopName = getForgeWorkspaceLoopName(entry)
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
    if (isPendingAttachWorkspace(entry, options)) {
      return { action: 'keep', reason: 'pending-attach' }
    }
    if (isPendingStartWorkspace(entry, options)) {
      return { action: 'keep', reason: 'pending-start' }
    }
    return { action: 'remove-fully', reason: 'missing-row', loopName }
  }

  // Check 8: running loops are kept (legitimate recovery case)
  if (row.status === 'running') {
    return { action: 'keep', reason: 'running' }
  }

  // Check 9: completed loops are fully removed
  if (row.status === 'completed') {
    return { action: 'remove-fully', reason: 'completed', loopName }
  }

  // Check 10: non-running restartable loops (cancelled, errored, stalled)
  // Remove registration only, preserve worktree for restart
  if (row.status === 'cancelled' || row.status === 'errored' || row.status === 'stalled') {
    return { action: 'remove-registration-only', reason: 'restartable', loopName }
  }

  // Fallback: should not reach here, but treat as keep to be safe
  return { action: 'keep', reason: 'running' }
}
