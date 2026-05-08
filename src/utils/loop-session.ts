import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../types'
import { bindSessionToWorkspace } from '../workspace/forge-worktree'
import { buildLoopPermissionRuleset } from '../constants/loop'

interface CreateLoopSessionInput {
  v2: OpencodeClient
  title: string
  directory: string
  permission?: ReturnType<typeof buildLoopPermissionRuleset>
  workspaceId?: string
  logPrefix: string
  logger: Logger | Console
  legacyClient?: import('@opencode-ai/sdk').OpencodeClient
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
    try {
      await bindSessionToWorkspace(input.v2, input.workspaceId, result.sessionId, input.logger)
      result.boundWorkspaceId = input.workspaceId
      input.logger.log(`${input.logPrefix}: workspace ${input.workspaceId} bound to session ${result.sessionId}`)

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
