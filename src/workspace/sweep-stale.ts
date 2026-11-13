import { z } from 'zod'
import type { ForgeClient } from '../client/port'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { PendingTeardownRegistry } from './pending-teardown'
import type { Logger } from '../types'
import type { ForgeWorkspaceEntry } from './forge-worktree'
import type { ClassifyAction } from './classify-stale'
import { classifyForgeWorkspace } from './classify-stale'
import { getForgeWorkspaceLoopName } from './forge-worktree'
import { removeForgeWorkspaceWithContext } from './remove-with-context'

export interface SweepStaleDeps {
  client: ForgeClient
  loopsRepo: LoopsRepo
  pendingTeardowns: PendingTeardownRegistry
  logger: Logger
}

export interface SweepStaleInput {
  projectId: string
  projectDirectory: string
  excludeLoopName?: string
}

export interface SweepStaleReport {
  swept: Array<{ loopName: string; workspaceId: string; action: 'remove-registration-only' | 'remove-fully' }>
  skipped: Array<{ workspaceId: string; reason: ClassifyAction['reason'] }>
  failed: Array<{ workspaceId: string; loopName?: string; error: string }>
}

const workspaceEntrySchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().nullish(),
  extra: z.record(z.string(), z.unknown()).nullish(),
})

export async function sweepStaleForgeWorkspaces(
  deps: SweepStaleDeps,
  input: SweepStaleInput,
): Promise<SweepStaleReport> {
  const { client, loopsRepo, pendingTeardowns, logger } = deps
  const { projectId, projectDirectory, excludeLoopName } = input

  const swept: SweepStaleReport['swept'] = []
  const skipped: SweepStaleReport['skipped'] = []
  const failed: SweepStaleReport['failed'] = []

  let entries: ForgeWorkspaceEntry[]
  try {
    const dataList = await client.workspace.list()
    entries = dataList.flatMap((value) => {
      const parsed = workspaceEntrySchema.safeParse(value)
      if (!parsed.success) return []
      return [{ id: parsed.data.id, type: parsed.data.type ?? null, extra: parsed.data.extra ?? null }]
    })
  } catch (cause) {
    logger.error('[sweep-stale] workspace.list threw; skipping sweep', cause)
    return { swept, skipped, failed }
  }

  for (const entry of entries) {
    const entryLoopName = getForgeWorkspaceLoopName(entry)
    if (excludeLoopName && entryLoopName === excludeLoopName) {
      continue
    }

    const action = classifyForgeWorkspace(entry, loopsRepo, projectId, projectDirectory)

    if (action.action === 'keep') {
      skipped.push({ workspaceId: entry.id, reason: action.reason })
      continue
    }

    const removeResult = await removeForgeWorkspaceWithContext(
      { client, pendingTeardowns, logger },
      {
        workspaceId: entry.id,
        loopName: action.loopName,
        action: action.action,
      },
    )

    if (removeResult.ok) {
      swept.push({ loopName: action.loopName, workspaceId: entry.id, action: action.action })
    } else {
      failed.push({ workspaceId: entry.id, loopName: action.loopName, error: removeResult.error ?? 'unknown error' })
    }
  }

  if (swept.length > 0 || skipped.length > 0 || failed.length > 0) {
    logger.log(
      `[sweep-stale] summary: swept=${swept.length} skipped=${skipped.length} failed=${failed.length} ` +
      `projectId=${projectId} projectDirectory=${projectDirectory}`,
    )
  }

  return { swept, skipped, failed }
}
