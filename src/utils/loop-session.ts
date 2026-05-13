import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'
import type { WorkspaceStatusRegistry } from '../utils/workspace-status-registry'
import { bindSessionToWorkspace } from '../workspace/forge-worktree'
import { buildLoopPermissionRuleset } from '../constants/loop'

interface CreateLoopSessionInput {
  v2: OpencodeClient
  title: string
  directory: string
  permission?: ReturnType<typeof buildLoopPermissionRuleset>
  workspaceId?: string
  loopName?: string
  logPrefix: string
  logger: Logger | Console
  legacyClient?: import('@opencode-ai/sdk').OpencodeClient
  workspaceStatusRegistry?: WorkspaceStatusRegistry
}

interface CreateLoopSessionResult {
  sessionId: string
  boundWorkspaceId?: string
  bindFailed: boolean
  bindError?: unknown
}

export async function createLoopSessionWithWorkspace(
  input: CreateLoopSessionInput,
): Promise<CreateLoopSessionResult | null> {
  const createParams: {
    title: string
    directory: string
    permission?: ReturnType<typeof buildLoopPermissionRuleset>
    workspaceID?: string
  } = {
    title: input.title,
    directory: input.directory,
  }
  if (input.permission) createParams.permission = input.permission
  if (input.workspaceId) createParams.workspaceID = input.workspaceId

  let sessionId: string

  const _sessionStart = Date.now()
  input.logger.log(`[warp] session.create.start loopName="${input.loopName ?? 'unknown'}" logPrefix="${input.logPrefix}"${input.workspaceId ? ` workspaceId=${input.workspaceId}` : ''}`)

  // Try v2 SDK first
  const createResult = await input.v2.session.create(createParams)
  if (createResult.error || !createResult.data) {
    const errorMsg = createResult.error instanceof Error ? createResult.error.message : String(createResult.error)
    if (errorMsg.includes('Unable to connect')) {
      input.logger.log(`${input.logPrefix}: v2 SDK unavailable, falling back to legacy SDK`)
    } else {
      input.logger.error(`${input.logPrefix}: failed to create session via v2 SDK`, createResult.error)
    }

    // Fallback to legacy SDK if available
    if (input.legacyClient) {
      try {
        const legacyResult = await input.legacyClient.session.create({
          body: {
            title: input.title,
            ...(input.permission ? { permission: input.permission } : {}),
          },
          query: {
            directory: input.directory,
          },
        } as Parameters<typeof input.legacyClient.session.create>[0])

        const session = legacyResult.data as { id?: string } | undefined
        if (session?.id) {
          input.logger.log(`${input.logPrefix}: created session via legacy SDK fallback`)
          sessionId = session.id
        } else {
          input.logger.error(`${input.logPrefix}: legacy SDK returned no session ID`)
          return null
        }
      } catch (err) {
        input.logger.error(`${input.logPrefix}: legacy SDK failed`, err)
        return null
      }
    } else {
      return null
    }
  } else {
    sessionId = createResult.data.id
  }

  input.logger.log(`[warp] session.create.complete loopName="${input.loopName ?? 'unknown'}" logPrefix="${input.logPrefix}" sessionId=${sessionId}${input.workspaceId ? ` workspaceId=${input.workspaceId}` : ''} elapsedMs=${Date.now() - _sessionStart}`)

  try {
    const verify = await input.v2.session.get({ sessionID: sessionId, directory: input.directory })
    const persisted = (verify.data as { permission?: unknown })?.permission ?? null
    input.logger.log(
      `${input.logPrefix}: [perm-diag] post-create session=${sessionId} requested=${input.permission ? JSON.stringify(input.permission) : '<none>'} persisted=${JSON.stringify(persisted)}`
    )
  } catch (err) {
    input.logger.error(`${input.logPrefix}: [perm-diag] post-create verify failed`, err)
  }

  const result: CreateLoopSessionResult = {
    sessionId,
    bindFailed: false,
  }

  if (input.workspaceId) {
    const _bindStart = Date.now()
    try {
      input.logger.log(`[warp] bind.start loopName="${input.loopName ?? 'unknown'}" workspaceId=${input.workspaceId} sessionId=${result.sessionId}`)
      await bindSessionToWorkspace(input.v2, input.workspaceId, result.sessionId, input.logger, { loopName: input.loopName }, input.workspaceStatusRegistry)
      result.boundWorkspaceId = input.workspaceId
      input.logger.log(`${input.logPrefix}: workspace ${input.workspaceId} bound to session ${result.sessionId}`)
      input.logger.log(`[warp] bind.complete loopName="${input.loopName ?? 'unknown'}" workspaceId=${input.workspaceId} sessionId=${result.sessionId} elapsedMs=${Date.now() - _bindStart}`)

      try {
        const afterBind = await input.v2.session.get({ sessionID: result.sessionId, directory: input.directory })
        const persisted = (afterBind.data as { permission?: unknown })?.permission ?? null
        input.logger.log(
          `${input.logPrefix}: [perm-diag] post-bind session=${result.sessionId} persisted=${JSON.stringify(persisted)}`
        )
        if (input.permission && JSON.stringify(persisted) !== JSON.stringify(input.permission)) {
          input.logger.error(
            `${input.logPrefix}: [perm-diag] DRIFT after workspace warp — persisted ruleset does not match requested`
          )
        }
      } catch (err) {
        input.logger.error(`${input.logPrefix}: [perm-diag] post-bind verify failed`, err)
      }
    } catch (bindErr) {
      input.logger.error(`${input.logPrefix}: failed to bind session to workspace; clearing workspace id`, bindErr)
      input.logger.log(`[warp] bind.failed loopName="${input.loopName ?? 'unknown'}" workspaceId=${input.workspaceId} sessionId=${result.sessionId} elapsedMs=${Date.now() - _bindStart} error="${bindErr instanceof Error ? bindErr.message : String(bindErr)}"`)
      result.bindFailed = true
      result.bindError = bindErr
    }
  }

  return result
}

interface WorkspaceDetachedToastInput {
  v2: OpencodeClient
  directory: string
  loopName: string
  variant?: 'warning'
  logger: Logger | Console
  context?: string
}

export function publishWorkspaceDetachedToast(input: WorkspaceDetachedToastInput): void {
  if (!input.v2.tui) return

  const message = input.context
    ? `Workspace attachment lost ${input.context}; session continues without workspace grouping.`
    : 'Workspace attachment lost; session continues without workspace grouping.'

  input.v2.tui.publish({
    directory: input.directory,
    body: {
      type: 'tui.toast.show',
      properties: {
        title: input.loopName,
        message,
        variant: input.variant ?? 'warning',
        duration: 5000,
      },
    },
  }).catch((err) => {
    input.logger.error('Loop: failed to publish workspace-detached toast', err)
  })
}
