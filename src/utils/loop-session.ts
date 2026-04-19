import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'
import { bindSessionToWorkspace } from '../workspace/forge-worktree'
import { buildLoopPermissionRuleset } from '../constants/loop'

interface CreateLoopSessionInput {
  v2: OpencodeClient
  title: string
  directory: string
  permission: ReturnType<typeof buildLoopPermissionRuleset>
  workspaceId?: string
  logPrefix: string
  logger: Logger | Console
}

interface CreateLoopSessionResult {
  sessionId: string
  boundWorkspaceId?: string
  bindFailed: boolean
}

export async function createLoopSessionWithWorkspace(
  input: CreateLoopSessionInput,
): Promise<CreateLoopSessionResult | null> {
  const createParams: {
    title: string
    directory: string
    permission: ReturnType<typeof buildLoopPermissionRuleset>
    workspaceID?: string
  } = {
    title: input.title,
    directory: input.directory,
    permission: input.permission,
  }

  if (input.workspaceId) {
    createParams.workspaceID = input.workspaceId
  }

  const createResult = await input.v2.session.create(createParams)
  if (createResult.error || !createResult.data) {
    input.logger.error(`${input.logPrefix}: failed to create session`, createResult.error)
    return null
  }

  const result: CreateLoopSessionResult = {
    sessionId: createResult.data.id,
    bindFailed: false,
  }

  if (input.workspaceId) {
    try {
      await bindSessionToWorkspace(input.v2, input.workspaceId, result.sessionId)
      result.boundWorkspaceId = input.workspaceId
      input.logger.log(`${input.logPrefix}: workspace ${input.workspaceId} bound to session ${result.sessionId}`)
    } catch (bindErr) {
      input.logger.error(`${input.logPrefix}: failed to bind session to workspace; clearing workspace id`, bindErr)
      result.bindFailed = true
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
