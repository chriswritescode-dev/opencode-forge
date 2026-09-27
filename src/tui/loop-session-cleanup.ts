import type { Plugin } from '@opencode/plugin/tui'
import { join, relative, sep } from 'path'
import type { ForgeRpcError, ForgeWorktreesOutput } from '../host/forge-rpc'
import { isWithinDir } from '../workspace/forge-naming'

const SESSION_LIST_PAGE_SIZE = 100

/** A successful server worktree listing, without the RPC error arm. */
export type ForgeWorktreeList = Exclude<ForgeWorktreesOutput, ForgeRpcError>

/**
 * Loads the server worktree listing. `fresh` bypasses any caller-side cache; the
 * post-paging re-check must always read the live list so a worktree created while
 * sessions were paging is not mistaken for an orphan.
 */
export type LoadForgeWorktrees = (options?: { fresh?: boolean }) => Promise<ForgeWorktreesOutput>

export function readForgeSessionDelete(data: Readonly<Record<string, unknown>>): string | null {
  return typeof data.sessionID === 'string' && data.sessionID.length > 0 ? data.sessionID : null
}

export async function removeSessionBestEffort(context: Plugin.Context, sessionID: string): Promise<void> {
  try {
    await context.client.session.remove({ sessionID })
  } catch (err) {
    console.error(`[forge] failed to delete session ${sessionID}`, err)
  }
}

function worktreeDirFor(root: string, directory: string): string | null {
  if (!isWithinDir(root, directory)) return null
  const rel = relative(root, directory)
  if (rel === '') return null
  const firstSegment = rel.split(sep)[0]
  return firstSegment ? join(root, firstSegment) : null
}

interface OrphanCandidate {
  sessionID: string
  worktreeDir: string
}

async function listOrphanCandidates(
  context: Plugin.Context,
  projectId: string,
  worktrees: ForgeWorktreeList,
  signal: AbortSignal,
): Promise<OrphanCandidate[]> {
  const knownDirs = new Set(worktrees.dirs)
  const candidates: OrphanCandidate[] = []
  let cursor: string | undefined
  while (!signal.aborted) {
    const page = await context.client.session.list(
      cursor ? { cursor } : { project: projectId, limit: SESSION_LIST_PAGE_SIZE },
    )
    for (const session of page.data) {
      const worktreeDir = worktreeDirFor(worktrees.root, session.location.directory)
      if (worktreeDir && !knownDirs.has(worktreeDir)) candidates.push({ sessionID: session.id, worktreeDir })
    }
    const next = page.cursor.next ?? undefined
    if (page.data.length < SESSION_LIST_PAGE_SIZE || !next) break
    cursor = next
  }
  return candidates
}

/**
 * Deletes loop sessions whose Forge worktree directory no longer exists. The
 * session list is paged against a first worktree snapshot, then the worktree
 * list is fetched again before deleting: a loop started while paging creates its
 * worktree directory before its session, so only a worktree absent from both
 * snapshots is a real orphan. A failed re-check deletes nothing.
 */
export async function removeOrphanedLoopSessions(
  context: Plugin.Context,
  projectId: string,
  loadWorktrees: LoadForgeWorktrees,
  signal: AbortSignal,
): Promise<number> {
  const initial = await loadWorktrees()
  if ('error' in initial) {
    console.error('[forge] failed to load server worktrees for orphan cleanup', initial.error)
    return 0
  }
  const candidates = await listOrphanCandidates(context, projectId, initial, signal)
  if (candidates.length === 0) return 0
  const latest = await loadWorktrees({ fresh: true })
  if ('error' in latest) {
    console.error('[forge] failed to reload server worktrees for orphan cleanup', latest.error)
    return 0
  }
  const liveDirs = new Set(latest.dirs)
  let removed = 0
  for (const candidate of candidates) {
    if (signal.aborted) break
    if (liveDirs.has(candidate.worktreeDir)) continue
    await removeSessionBestEffort(context, candidate.sessionID)
    removed += 1
  }
  return removed
}
