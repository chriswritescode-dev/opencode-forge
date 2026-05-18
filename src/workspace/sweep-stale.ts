/**
 * Opportunistic sweep of stale forge workspaces during loop teardown.
 *
 * Invoked from teardownWorktree in host-side-effects.ts after the terminating
 * loop's own workspace is removed. Scans same-project forge workspaces and
 * removes those classified as stale (completed, missing-row, restartable-terminal).
 *
 * The sweep is fire-and-forget: failures are logged but never block the teardown.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { PendingTeardownRegistry } from './pending-teardown'
import type { Logger } from '../types'
import type { ForgeWorkspaceEntry, ClassifyAction } from './classify-stale'
import { classifyForgeWorkspace } from './classify-stale'
import { getForgeWorkspaceLoopName } from './forge-worktree'
import { removeForgeWorkspaceWithContext } from './remove-with-context'

export interface SweepStaleDeps {
  v2: OpencodeClient
  loopsRepo: LoopsRepo
  pendingTeardowns: PendingTeardownRegistry
  logger: Logger
}

export interface SweepStaleInput {
  projectId: string
  projectDirectory: string
  excludeLoopName?: string
  reasonLabel?: string
}

export interface SweepStaleReport {
  swept: Array<{ loopName: string; workspaceId: string; action: 'remove-registration-only' | 'remove-fully' }>
  skipped: Array<{ workspaceId: string; reason: ClassifyAction['reason'] }>
  failed: Array<{ workspaceId: string; loopName?: string; error: string }>
}

/**
 * Sweep stale forge workspaces in the same project.
 *
 * - Lists all workspaces via v2.experimental.workspace.list()
 * - Filters to forge workspaces in the same projectDirectory
 * - Excludes the terminating loop's own workspace (excludeLoopName)
 * - Classifies each entry via classifyForgeWorkspace
 * - Removes stale entries via removeForgeWorkspaceWithContext
 * - Returns a report with swept, skipped, and failed entries
 *
 * Failures are isolated: one failed removal does not abort the sweep.
 */
export async function sweepStaleForgeWorkspaces(
  deps: SweepStaleDeps,
  input: SweepStaleInput,
): Promise<SweepStaleReport> {
  const { v2, loopsRepo, pendingTeardowns, logger } = deps
  const { projectId, projectDirectory, excludeLoopName, reasonLabel = 'orphan-sweep' } = input

  const swept: SweepStaleReport['swept'] = []
  const skipped: SweepStaleReport['skipped'] = []
  const failed: SweepStaleReport['failed'] = []

  const workspaceApi = v2.experimental?.workspace
  if (!workspaceApi || typeof workspaceApi.list !== 'function') {
    logger.error('[sweep-stale] experimental.workspace.list not available; skipping sweep')
    return { swept, skipped, failed }
  }

  let entries: ForgeWorkspaceEntry[]
  try {
    const result = await workspaceApi.list()
    const dataList = ((result as { data?: unknown[] } | undefined)?.data ?? []) as Array<{ id?: unknown; type?: unknown; extra?: unknown }>
    entries = dataList
      .filter((e) => e.id && typeof e.id === 'string')
      .map((e) => ({
        id: e.id as string,
        type: typeof e.type === 'string' ? e.type : null,
        extra: (e.extra ?? {}) as Record<string, unknown> | null,
      }))
  } catch (err) {
    logger.error('[sweep-stale] workspace.list threw; skipping sweep', err)
    return { swept, skipped, failed }
  }

  for (const entry of entries) {
    // Skip the terminating loop's own workspace
    const entryLoopName = getForgeWorkspaceLoopName(entry)
    if (excludeLoopName && entryLoopName === excludeLoopName) {
      continue
    }

    // Classify the workspace
    const action = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory)

    if (action.action === 'keep') {
      skipped.push({ workspaceId: entry.id, reason: action.reason })
      continue
    }

    // Attempt removal
    const removeResult = await removeForgeWorkspaceWithContext(
      { v2, pendingTeardowns, logger },
      {
        workspaceId: entry.id,
        loopName: action.loopName,
        action: action.action,
        reasonLabel,
      },
    )

    if (removeResult.ok) {
      swept.push({ loopName: action.loopName, workspaceId: entry.id, action: action.action })
    } else {
      failed.push({ workspaceId: entry.id, loopName: action.loopName, error: removeResult.error ?? 'unknown error' })
    }
  }

  // Log structured summary
  if (swept.length > 0 || skipped.length > 0 || failed.length > 0) {
    logger.log(
      `[sweep-stale] summary: swept=${swept.length} skipped=${skipped.length} failed=${failed.length} ` +
      `projectId=${projectId} projectDirectory=${projectDirectory}`,
    )
  }

  return { swept, skipped, failed }
}
