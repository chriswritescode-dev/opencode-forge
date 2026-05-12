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
  // Always write a log entry so we can trace and restart later.
  writeTerminationLog(state, reason, ctx)

  // Publish a TUI toast notification.
  publishTerminationToast(state, reason, ctx)

  // Tear down the worktree if one was created.
  await teardownWorktree(state, reason, ctx)
}

// ---------------------------------------------------------------------------
// 1. Completion / termination log
// ---------------------------------------------------------------------------

/** Write a worktree log entry on every termination reason so we can trace and restart later. */
function writeTerminationLog(
  state: LoopState,
  _reason: TerminationReason,
  ctx: TerminationSideEffectsContext,
): void {
  if (!state.worktree) return

  const projectDir = state.projectDir ?? state.worktreeDir
  const planText = ctx.getPlanText?.(state.loopName, state.sessionId)
  const completionTimestamp = new Date()

  const result = buildWorktreeCompletionPayload(
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

  if (!result) return

  result.payload.planText = planText
  const written = writeWorktreeCompletionLog(result.payload, ctx.logger)
  if (written) {
    ctx.logger.log(`Loop: worktree completion log written to ${result.hostPath}`)
  } else {
    ctx.logger.error(`Loop: failed to write worktree completion log to ${result.hostPath}`)
  }
}

// ---------------------------------------------------------------------------
// 2. TUI toast
// ---------------------------------------------------------------------------

/** Publish a TUI toast whose variant and message depend on the termination kind. */
function publishTerminationToast(
  state: LoopState,
  reason: TerminationReason,
  ctx: TerminationSideEffectsContext,
): void {
  if (!ctx.v2Client.tui) return

  const variants = getToastVariant(reason)
  const message = getToastMessage(state, reason)

  ctx.v2Client.tui.publish({
    directory: state.projectDir ?? state.worktreeDir,
    body: {
      type: 'tui.toast.show',
      properties: {
        title: state.loopName,
        message,
        variant: variants.variant,
        duration: variants.duration,
      },
    },
  }).catch((err: unknown) => {
    ctx.logger.error('Loop: failed to publish toast notification', err)
  })
}

function getToastVariant(reason: TerminationReason): { variant: 'info' | 'success' | 'warning' | 'error'; duration: number } {
  switch (reason.kind) {
    case 'completed':
      return { variant: 'success', duration: 5000 }
    case 'cancelled':
    case 'user_aborted':
      return { variant: 'info', duration: 3000 }
    case 'max_iterations':
      return { variant: 'warning', duration: 3000 }
    case 'stall_timeout':
      return { variant: 'error', duration: 3000 }
    default:
      return { variant: 'error', duration: 3000 }
  }
}

function getToastMessage(state: LoopState, reason: TerminationReason): string {
  const iterLabel = `${state.iteration} iteration${state.iteration !== 1 ? 's' : ''}`
  switch (reason.kind) {
    case 'completed':
      return `Completed after ${iterLabel}`
    case 'cancelled':
      return 'Loop cancelled'
    case 'max_iterations':
      return `Reached max iterations (${state.maxIterations})`
    case 'stall_timeout':
      return `Stalled after ${iterLabel}`
    case 'user_aborted':
      return 'Loop aborted by user'
    default:
      return `Loop ended: ${terminationReasonToString(reason)}`
  }
}

// ---------------------------------------------------------------------------
// 3. Worktree teardown (always commits unless directory is already gone)
// ---------------------------------------------------------------------------

/** Tear down the worktree workspace — always commits changes back. */
async function teardownWorktree(
  state: LoopState,
  reason: TerminationReason,
  ctx: TerminationSideEffectsContext,
): Promise<void> {
  if (!state.worktree || !state.workspaceId) return

  const reasonLabel = resolveReasonLabel(reason)
  const doCommit = reason.kind !== 'missing_worktree_dir'
  const doRemoveWorktree = reason.kind === 'completed'
  const doDeleteBranch = reason.kind === 'completed'

  ctx.pendingTeardowns?.set(state.loopName, {
    iteration: state.iteration,
    reasonLabel,
    doCommit,
    doRemoveWorktree,
    doDeleteBranch,
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

/** Map any termination reason to a short label for commit messages. */
function resolveReasonLabel(reason: TerminationReason): string {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'stall_timeout':
      return 'stalled'
    case 'error_max_retries':
    case 'decomposer_error':
    case 'worktree_failed':
      return 'errored'
    case 'session_creation_failed':
    case 'decomposition_failed':
    case 'decomposer_prompt_failed':
    case 'audit_retry_exhausted':
    case 'final_audit_retry_exhausted':
    case 'coding_no_assistant':
      return 'errored'
    case 'missing_worktree_dir':
      return 'removed'
    case 'shutdown':
      return 'shutdown'
    case 'user_aborted':
      return 'aborted'
    case 'max_iterations':
      return 'max_iterations'
  }
}
