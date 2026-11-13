import type { Plugin } from '@opencode/plugin/tui'
import { join, relative, sep } from 'path'
import { z } from 'zod'
import type { ForgeRpcError, ForgeWorktreesOutput } from '../host/forge-rpc'
import { isWithinDir } from '../workspace/forge-naming'
import type { JsonObject } from '../utils/json-schema'

const SESSION_LIST_PAGE_SIZE = 100

const sessionDeleteSchema = z.looseObject({ sessionID: z.string().min(1) })

export type ForgeWorktreeList = Exclude<ForgeWorktreesOutput, ForgeRpcError>

export type LoadForgeWorktrees = (options?: { fresh?: boolean }) => Promise<ForgeWorktreesOutput>

export function readForgeSessionDelete(data: JsonObject): string | null {
  const parsed = sessionDeleteSchema.safeParse(data)
  return parsed.success ? parsed.data.sessionID : null
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
