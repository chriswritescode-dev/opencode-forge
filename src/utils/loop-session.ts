import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'
import type { WorkspaceStatusRegistry } from '../utils/workspace-status-registry'
import { bindSessionToWorkspace } from '../workspace/forge-worktree'
import { buildLoopPermissionRuleset } from '../constants/loop'

interface CreateLoopSessionInput {
  client: ForgeClient
  title: string
  directory: string
  permission?: ReturnType<typeof buildLoopPermissionRuleset>
  workspaceId?: string
  loopName?: string
  logPrefix: string
  logger: Logger | Console
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
  const { client } = input
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

  try {
    const session = await client.session.create(createParams)
    sessionId = session.id
  } catch (err) {
    input.logger.error(`${input.logPrefix}: failed to create session`, err)
    return null
  }

  input.logger.log(`[warp] session.create.complete loopName="${input.loopName ?? 'unknown'}" logPrefix="${input.logPrefix}" sessionId=${sessionId}${input.workspaceId ? ` workspaceId=${input.workspaceId}` : ''} elapsedMs=${Date.now() - _sessionStart}`)

  const result: CreateLoopSessionResult = {
    sessionId,
    bindFailed: false,
  }

  if (input.workspaceId) {
    const _bindStart = Date.now()
    try {
      input.logger.log(`[warp] bind.start loopName="${input.loopName ?? 'unknown'}" workspaceId=${input.workspaceId} sessionId=${result.sessionId}`)
      await bindSessionToWorkspace(client, input.workspaceId, result.sessionId, input.logger, { loopName: input.loopName }, input.workspaceStatusRegistry)
      result.boundWorkspaceId = input.workspaceId
      input.logger.log(`${input.logPrefix}: workspace ${input.workspaceId} bound to session ${result.sessionId}`)
      input.logger.log(`[warp] bind.complete loopName="${input.loopName ?? 'unknown'}" workspaceId=${input.workspaceId} sessionId=${result.sessionId} elapsedMs=${Date.now() - _bindStart}`)
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
  client: ForgeClient
  directory: string
  loopName: string
  variant?: 'warning'
  logger: Logger | Console
  context?: string
}

export function publishWorkspaceDetachedToast(input: WorkspaceDetachedToastInput): void {
  const { client } = input
  const message = input.context
    ? `Workspace attachment lost ${input.context}; session continues without workspace grouping.`
    : 'Workspace attachment lost; session continues without workspace grouping.'

  client.tui.publish({
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
  }).catch((err: unknown) => {
    input.logger.error('Loop: failed to publish workspace-detached toast', err)
  })
}
