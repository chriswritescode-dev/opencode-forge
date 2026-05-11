import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { Logger } from '../types'

const orphanSweepWorkspaceIds = new Set<string>()

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotFoundError' || err.message.includes('NotFoundError'))
}

export async function sweepOrphanWorkspaces(opts: {
  v2Client: OpencodeClient
  loopsRepo: LoopsRepo
  projectId: string
  logger: Logger
}): Promise<{ removed: number; errors: string[] }> {
  const { v2Client, loopsRepo, projectId, logger } = opts
  const result = { removed: 0, errors: [] as string[] }

  const workspaceApi = v2Client.experimental?.workspace
  if (!workspaceApi?.list) {
    logger.log('Sweep: experimental.workspace.list not available, skipping orphan sweep')
    return result
  }

  try {
    const listResult = await workspaceApi.list()
    const workspaces = (listResult.data ?? []) as Array<{
      id: string
      type?: string
      directory?: string
      extra?: unknown
    }>

    const forgeWorktreeWorkspaces = workspaces.filter((w) => w.type === 'forge')
    if (forgeWorktreeWorkspaces.length === 0) {
      return result
    }

    const activeRows = loopsRepo.listByStatus(projectId, ['running'])
    const activeWorkspaceIds = new Set(activeRows.map((r) => r.workspaceId).filter((id): id is string => id !== null))

    for (const workspace of forgeWorktreeWorkspaces) {
      if (activeWorkspaceIds.has(workspace.id)) {
        continue
      }
      if (orphanSweepWorkspaceIds.has(workspace.id)) {
        logger.debug(`Sweep: workspace ${workspace.id} already being swept, skipping`)
        continue
      }

      orphanSweepWorkspaceIds.add(workspace.id)
      logger.log(`Sweep: found orphan workspace ${workspace.id} (type=forge)`)

      try {
        const sessionApi = v2Client.experimental?.session
        if (sessionApi?.list) {
          try {
            const sessionResult = await sessionApi.list({ workspace: workspace.id })
            const sessions = (sessionResult.data ?? []) as Array<{ id: string }>
            for (const session of sessions) {
              try {
                await v2Client.session.delete({ sessionID: session.id, directory: workspace.directory ?? projectId })
                logger.log(`Sweep: deleted orphan session ${session.id} in workspace ${workspace.id}`)
              } catch (err) {
                if (isNotFoundError(err)) {
                  logger.debug(`Sweep: orphan session ${session.id} already deleted`)
                  continue
                }

                const msg = err instanceof Error ? err.message : String(err)
                result.errors.push(`Failed to delete session ${session.id}: ${msg}`)
                logger.error(`Sweep: failed to delete session ${session.id}`, err)
              }
            }
          } catch (err) {
            logger.error(`Sweep: failed to list sessions in workspace ${workspace.id}`, err)
          }
        }

        try {
          await workspaceApi.remove({ id: workspace.id })
          result.removed++
          logger.log(`Sweep: removed orphan workspace ${workspace.id}`)
        } catch (err) {
          if (isNotFoundError(err)) {
            logger.debug(`Sweep: orphan workspace ${workspace.id} already removed`)
            continue
          }

          const msg = err instanceof Error ? err.message : String(err)
          result.errors.push(`Failed to remove workspace ${workspace.id}: ${msg}`)
          logger.error(`Sweep: failed to remove workspace ${workspace.id}`, err)
        }
      } finally {
        orphanSweepWorkspaceIds.delete(workspace.id)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`Orphan sweep failed: ${msg}`)
    logger.error('Sweep: orphan sweep failed', err)
  }

  return result
}
