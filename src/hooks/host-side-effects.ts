import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopState, TerminationReason } from '../loop'
import type { Logger, PluginConfig } from '../types'
import type { createSandboxManager } from '../sandbox/manager'
import { terminationReasonToString } from '../loop'
import { buildWorktreeCompletionPayload, writeWorktreeCompletionLog } from '../services/worktree-log'
import { teardownWorktreeArtifacts } from '../utils/worktree-cleanup'

export interface TerminationSideEffectsContext {
  v2Client: OpencodeClient
  logger: Logger
  getConfig: () => PluginConfig
  sandboxManager?: ReturnType<typeof createSandboxManager>
  dataDir?: string
  getPlanText?: (loopName: string, sessionId: string) => string | null
}

/**
 * Host-specific termination side-effects invoked via onTerminated callback.
 * Keeps worktree teardown, completion log, sandbox stop, TUI toast outside the core runtime module.
 */
export async function performTerminationSideEffects(
  state: LoopState,
  reason: TerminationReason,
  sessionId: string,
  ctx: TerminationSideEffectsContext,
): Promise<void> {
  const projectDir = state.projectDir ?? state.worktreeDir

  if (reason.kind === 'completed' && state.worktree) {
    const completionTimestamp = new Date()
    const planText = ctx.getPlanText?.(state.loopName, state.sessionId)

    const completionResult = buildWorktreeCompletionPayload(
      ctx.getConfig(),
      {
        projectDir,
        loopName: state.loopName,
        completionTimestamp,
        iteration: state.iteration,
        worktreeBranch: state.worktreeBranch,
        dataDir: ctx.dataDir,
      },
      ctx.logger,
    )

    if (completionResult) {
      completionResult.payload.planText = planText
      const written = writeWorktreeCompletionLog(completionResult.payload, ctx.logger)
      if (written) {
        ctx.logger.log(`Loop: worktree completion log written to ${completionResult.hostPath}`)
      } else {
        ctx.logger.error(`Loop: failed to write worktree completion log to ${completionResult.hostPath}`)
      }
    } else {
      ctx.logger.log(`Loop: worktree completion logging skipped (payload build failed or disabled)`)
    }
  }

  if (ctx.v2Client.tui) {
    const toastVariant = reason.kind === 'completed' ? 'success'
      : reason.kind === 'cancelled' || reason.kind === 'user_aborted' ? 'info'
      : reason.kind === 'max_iterations' ? 'warning'
      : reason.kind === 'stall_timeout' ? 'error'
      : 'error'

    const toastMessage = reason.kind === 'completed' ? `Completed after ${state.iteration} iteration${state.iteration !== 1 ? 's' : ''}`
      : reason.kind === 'cancelled' ? 'Loop cancelled'
      : reason.kind === 'max_iterations' ? `Reached max iterations (${state.maxIterations})`
      : reason.kind === 'stall_timeout' ? `Stalled after ${state.iteration} iteration${state.iteration !== 1 ? 's' : ''}`
      : reason.kind === 'user_aborted' ? 'Loop aborted by user'
      : `Loop ended: ${terminationReasonToString(reason)}`

    ctx.v2Client.tui.publish({
      directory: state.projectDir ?? state.worktreeDir,
      body: {
        type: 'tui.toast.show',
        properties: {
          title: state.loopName,
          message: toastMessage,
          variant: toastVariant,
          duration: reason.kind === 'completed' ? 5000 : 3000,
        },
      },
    }).catch((err: unknown) => {
      ctx.logger.error('Loop: failed to publish toast notification', err)
    })
  }

  if (state.worktree) {
    const reasonLabel =
      reason.kind === 'completed' ? 'completed'
      : reason.kind === 'cancelled' ? 'cancelled'
      : reason.kind === 'stall_timeout' ? 'stalled'
      : reason.kind === 'error_max_retries' || reason.kind === 'decomposer_error' || reason.kind === 'worktree_failed' ? 'errored'
      : reason.kind

    const doCommit = reason.kind !== 'missing_worktree_dir'
    const doRemoveWorktree = reason.kind !== 'missing_worktree_dir'

    const teardown = await teardownWorktreeArtifacts({
      v2: ctx.v2Client,
      loopName: state.loopName,
      sessionId,
      workspaceId: state.workspaceId,
      worktreeDir: state.worktreeDir,
      projectDir: state.projectDir,
      worktree: true,
      doCommit,
      doRemoveWorktree,
      reasonLabel,
      worktreeBranch: state.worktreeBranch,
      iteration: state.iteration,
      logPrefix: 'Loop',
      logger: ctx.logger,
    })

    ctx.logger.log(`Loop: teardown for ${state.loopName} sessionDeleted=${teardown.sessionDeleted} workspaceDeleted=${teardown.workspaceDeleted} worktreeRemoved=${teardown.worktreeRemoved}`)
  }

  if (state.sandbox && state.sandboxContainer && ctx.sandboxManager) {
    try {
      await ctx.sandboxManager.stop(state.loopName!)
      ctx.logger.log(`Loop: stopped sandbox container for ${state.loopName}`)
    } catch (err) {
      ctx.logger.error(`Loop: failed to stop sandbox container`, err)
    }
  }
}
