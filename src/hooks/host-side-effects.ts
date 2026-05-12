import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopState, TerminationReason } from '../loop'
import type { Logger, PluginConfig } from '../types'
import type { createSandboxManager } from '../sandbox/manager'
import { terminationReasonToString } from '../loop'
import { buildWorktreeCompletionPayload, writeWorktreeCompletionLog } from '../services/worktree-log'
import type { PendingTeardownRegistry } from '../workspace/pending-teardown'

export interface TerminationSideEffectsContext {
  v2Client: OpencodeClient
  logger: Logger
  getConfig: () => PluginConfig
  sandboxManager?: ReturnType<typeof createSandboxManager>
  dataDir?: string
  getPlanText?: (loopName: string, sessionId: string) => string | null
  pendingTeardowns?: PendingTeardownRegistry
}

/**
 * Host-specific termination side-effects invoked via onTerminated callback.
 *
 * Worktree teardown (commit, branch rename, sandbox stop, worktree remove,
 * branch delete) lives in the forge workspace adapter so the same logic runs
 * whether the loop terminates normally, the orphan sweep removes a stale
 * workspace, or the user deletes the workspace from the TUI. We only set the
 * pending-teardown context here so the adapter can build an informative
 * commit message.
 */
export async function performTerminationSideEffects(
  state: LoopState,
  reason: TerminationReason,
  _sessionId: string,
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

  if (state.worktree && state.workspaceId) {
    const reasonLabel =
      reason.kind === 'completed' ? 'completed'
      : reason.kind === 'cancelled' ? 'cancelled'
      : reason.kind === 'stall_timeout' ? 'stalled'
      : reason.kind === 'error_max_retries' || reason.kind === 'decomposer_error' || reason.kind === 'worktree_failed' ? 'errored'
      : reason.kind

    // The worktree directory may already be gone when the reason is
    // `missing_worktree_dir`; skip the commit step in that case but still
    // route through workspace.remove so the workspace record and any
    // residual git metadata are cleaned up.
    const doCommit = reason.kind !== 'missing_worktree_dir'

    ctx.pendingTeardowns?.set(state.loopName, {
      iteration: state.iteration,
      reasonLabel,
      doCommit,
    })

    try {
      const workspaceApi = ctx.v2Client.experimental?.workspace
      if (workspaceApi?.remove) {
        const result = await workspaceApi.remove({ id: state.workspaceId })
        if (result.error) {
          ctx.logger.error(`Loop: workspace.remove returned error for ${state.workspaceId}`, result.error)
        } else {
          ctx.logger.log(`Loop: workspace ${state.workspaceId} removed for ${state.loopName}`)
        }
      } else {
        ctx.logger.error('Loop: experimental.workspace.remove not available; cannot tear down worktree')
      }
    } catch (err) {
      ctx.logger.error(`Loop: workspace.remove threw for ${state.workspaceId}`, err)
    } finally {
      ctx.pendingTeardowns?.clear(state.loopName)
    }
  }
}
