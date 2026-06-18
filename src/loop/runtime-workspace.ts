import type { ForgeClient } from '../client/port'
import type { LoopService } from './service'
import type { LoopState } from './state'
import type { Logger } from '../types'
import { publishWorkspaceDetachedToast } from '../utils/loop-session'
import { bindSessionToWorkspace } from '../workspace/forge-worktree'

export function isWorkspaceNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err ?? '')
  return /Workspace not found/i.test(msg)
}

export interface WorkspaceLifecycleDeps {
  client: ForgeClient
  logger: Logger
  loopService: LoopService
}

export interface WorkspaceLifecycle {
  detachFromWorkspace(loopName: string, state: LoopState, context?: string): void
  recoverFromMissingWorkspace(
    loopName: string,
    state: LoopState,
    sessionId: string,
    contextLabel: string,
    bindError?: unknown,
  ): Promise<{ workspaceId?: string; recovered: boolean }>
  ensureWorkspaceForLoop(
    loopName: string,
    state: LoopState,
    contextLabel: string,
  ): Promise<{ workspaceId?: string }>
}

export function createWorkspaceLifecycle(deps: WorkspaceLifecycleDeps): WorkspaceLifecycle {
  const { client, logger, loopService } = deps

  function detachFromWorkspace(
    loopName: string,
    state: LoopState,
    context?: string,
  ): void {
    loopService.clearWorkspaceId(loopName)
    state.workspaceId = undefined
    publishWorkspaceDetachedToast({
      client,
      directory: state.projectDir ?? state.worktreeDir,
      loopName,
      logger,
      context,
    })
  }

  async function recoverFromMissingWorkspace(
    loopName: string,
    state: LoopState,
    sessionId: string,
    contextLabel: string,
    bindError?: unknown,
  ): Promise<{ workspaceId?: string; recovered: boolean }> {
    if (!state.workspaceId) {
      return { recovered: false }
    }

    if (bindError && !isWorkspaceNotFoundError(bindError)) {
      logger.log(`Loop: skipping workspace re-provision for ${loopName} because bind error is not "workspace not found"`)
      return { recovered: false }
    }

    detachFromWorkspace(loopName, state, contextLabel)

    const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
    const projectDirectory = state.projectDir ?? state.worktreeDir
    if (!projectDirectory) {
      logger.log(`Loop: cannot recover workspace for ${loopName}: no projectDir/worktreeDir`)
      return { recovered: false }
    }
    const newWorkspace = await createBuiltinWorktreeWorkspace(
      client,
      {
        loopName,
        directory: projectDirectory,
      },
      logger,
    )

    if (!newWorkspace) {
      logger.error(`Loop: workspace re-provision failed for ${loopName}, continuing without workspace backing`)
      return { recovered: false }
    }

    try {
      await bindSessionToWorkspace(client, newWorkspace.workspaceId, sessionId, logger, { loopName })
      loopService.setWorkspaceId(loopName, newWorkspace.workspaceId)
      state.workspaceId = newWorkspace.workspaceId
      if (newWorkspace.directory) state.worktreeDir = newWorkspace.directory
      if (newWorkspace.branch) state.worktreeBranch = newWorkspace.branch
      logger.log(`Loop: re-provisioned workspace ${newWorkspace.workspaceId} for ${loopName} after stale id`)
      return { workspaceId: newWorkspace.workspaceId, recovered: true }
    } catch (err) {
      logger.error(`Loop: failed to bind session to re-provisioned workspace ${newWorkspace.workspaceId}`, err)
      return { recovered: false }
    }
  }

  async function ensureWorkspaceForLoop(
    loopName: string,
    state: LoopState,
    contextLabel: string,
  ): Promise<{ workspaceId?: string }> {
    if (state.workspaceId) {
      return { workspaceId: state.workspaceId }
    }

    if (!state.worktree) {
      return {}
    }

    const { createBuiltinWorktreeWorkspace } = await import('../workspace/forge-worktree')
    const projectDirectory = state.projectDir ?? state.worktreeDir
    if (!projectDirectory) {
      logger.log(`Loop: cannot provision workspace for ${loopName} (${contextLabel}): no projectDir/worktreeDir`)
      return {}
    }
    const workspace = await createBuiltinWorktreeWorkspace(
      client,
      {
        loopName,
        directory: projectDirectory,
      },
      logger,
    )

    if (!workspace) {
      logger.log(`Loop: workspace creation failed for ${loopName} (${contextLabel}), continuing without workspace backing`)
      return {}
    }

    loopService.setWorkspaceId(loopName, workspace.workspaceId)
    state.workspaceId = workspace.workspaceId
    if (workspace.directory) state.worktreeDir = workspace.directory
    if (workspace.branch) state.worktreeBranch = workspace.branch
    logger.log(`Loop: provisioned workspace ${workspace.workspaceId} for ${loopName} (${contextLabel})`)
    return { workspaceId: workspace.workspaceId }
  }

  return {
    detachFromWorkspace,
    recoverFromMissingWorkspace,
    ensureWorkspaceForLoop,
  }
}
