import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { ForgeWorkspaceEntry } from './forge-worktree'
import { getForgeWorkspaceForgeLoop, getForgeWorkspaceLoopName, getForgeWorkspaceProjectDirectory, readForgeExtraNumber } from './forge-worktree'

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
  const forgeLoop = getForgeWorkspaceForgeLoop(entry)
  if (forgeLoop?.initialPromptOwner !== 'tui') return false

  const startedAt = forgeLoop.pendingAttachStartedAt
  if (startedAt === undefined) return false

  const nowMs = options.nowMs ?? Date.now()
  const graceMs = options.pendingAttachGraceMs ?? PENDING_ATTACH_GRACE_MS
  return nowMs - startedAt <= graceMs
}

function isPendingStartWorkspace(
  entry: ForgeWorkspaceEntry,
  options: ClassifyForgeWorkspaceOptions = {},
): boolean {
  const startedAt = readForgeExtraNumber(entry, 'workspaceCreatedAt')
  if (startedAt === undefined) return false

  const nowMs = options.nowMs ?? Date.now()
  const graceMs = options.pendingAttachGraceMs ?? PENDING_ATTACH_GRACE_MS
  return nowMs - startedAt <= graceMs
}

export function classifyForgeWorkspace(
  entry: ForgeWorkspaceEntry,
  loopsRepo: LoopsRepo,
  projectId: string,
  projectDirectory: string,
  options: ClassifyForgeWorkspaceOptions = {},
): ClassifyAction {
  if (entry.type !== 'forge') {
    return { action: 'keep', reason: 'not-forge' }
  }

  const loopName = getForgeWorkspaceLoopName(entry)
  if (!loopName) {
    return { action: 'keep', reason: 'no-loop-name' }
  }

  const wsProjectDir = getForgeWorkspaceProjectDirectory(entry)
  if (!wsProjectDir) {
    return { action: 'keep', reason: 'no-project-directory' }
  }

  if (wsProjectDir !== projectDirectory) {
    return { action: 'keep', reason: 'wrong-project' }
  }

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

  if (row.status === 'running') {
    return { action: 'keep', reason: 'running' }
  }

  if (row.status === 'completed') {
    return { action: 'remove-fully', reason: 'completed', loopName }
  }

  if (row.status === 'cancelled' || row.status === 'errored' || row.status === 'stalled') {
    if (isPendingStartWorkspace(entry, options)) {
      return { action: 'keep', reason: 'pending-start' }
    }
    return { action: 'remove-registration-only', reason: 'restartable', loopName }
  }

  return { action: 'keep', reason: 'running' }
}
