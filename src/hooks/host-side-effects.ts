import type { ForgeClient } from '../client/port'
import type { LoopState, TerminationReason } from '../loop'
import type { Logger, PluginConfig } from '../types'
import type { createSandboxManager } from '../sandbox/manager'
import { terminationReasonToString } from '../loop'
import { buildWorktreeCompletionPayload, writeWorktreeCompletionLog } from '../services/worktree-log'
import type { PendingTeardownRegistry } from '../workspace/pending-teardown'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import { aggregateToUsageSummary } from '../utils/loop-format'
import { sweepStaleForgeWorkspaces } from '../workspace/sweep-stale'
import { selectSessionBestEffort } from '../utils/tui-navigation'
import { cleanupLoopWorktree } from '../utils/worktree-cleanup'

export interface TerminationSideEffectsContext {
  client: ForgeClient
  logger: Logger
  getConfig: () => PluginConfig
  sandboxManager?: ReturnType<typeof createSandboxManager>
  dataDir?: string
  getPlanText?: (loopName: string, sessionId: string) => string | null
  pendingTeardowns?: PendingTeardownRegistry
  loopsRepo?: LoopsRepo
  projectId?: string
  loopSessionUsageRepo?: LoopSessionUsageRepo
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

  // Fetch cumulative usage after runtime termination has captured the final session
  const usageAggregate = ctx.projectId && ctx.loopSessionUsageRepo
    ? ctx.loopSessionUsageRepo.getAggregate(ctx.projectId, state.loopName)
    : null
  const usage = usageAggregate ? aggregateToUsageSummary(usageAggregate) : null

  const result = buildWorktreeCompletionPayload(
    ctx.getConfig(),
    {
      projectDir,
      loopName: state.loopName,
      completionTimestamp,
      iteration: state.iteration,
      worktreeBranch: state.worktreeBranch,
      dataDir: ctx.dataDir,
      usage,
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
  const variants = getToastVariant(reason)
  const message = getToastMessage(state, reason)

  ctx.client.tui.publish({
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

/**
 * Unwarp the TUI back to the host project session before workspace removal.
 *
 * The TUI may currently be "warped" — displaying the workspace's worktree
 * session. Once `workspace.remove` fires, that view becomes orphaned. We reuse
 * the same navigation path as warp-in (`selectSessionBestEffort`): the
 * `tui.selectSession` command first, falling back to a `tui.session.select`
 * publish. Selecting through the current workspace context reaches a TUI that
 * is still scoped to the soon-to-be-removed workspace; selecting without a
 * workspace reaches local project views. Best-effort: failures are logged but
 * never block teardown.
 */
async function unwarpToHostSession(
  state: LoopState,
  ctx: TerminationSideEffectsContext,
): Promise<void> {
  if (!state.hostSessionId || !state.projectDir) return

  if (state.workspaceId) {
    await selectSessionBestEffort(ctx.client, state.projectDir, ctx.logger, {
      sessionID: state.hostSessionId,
      workspace: state.workspaceId,
    })
  }

  await selectSessionBestEffort(ctx.client, state.projectDir, ctx.logger, {
    sessionID: state.hostSessionId,
  })

  const settleMs = resolveUnwarpSettleMs()
  if (settleMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs))
  }
  ctx.logger.log(`Loop: unwarped TUI to host session ${state.hostSessionId} for ${state.loopName}`)
}

function resolveUnwarpSettleMs(): number {
  const raw = Number(process.env.FORGE_UNWARP_SETTLE_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 750
}

/** Tear down the worktree workspace — always commits changes back. */
async function teardownWorktree(
  state: LoopState,
  reason: TerminationReason,
  ctx: TerminationSideEffectsContext,
): Promise<void> {
  if (!state.worktree || !state.workspaceId) return

  const reasonLabel = resolveReasonLabel(reason)
  const doCommit = true
  const doRemoveWorktree = reason.kind === 'completed'
  const removeWorktreeAfterWorkspaceRemoval = doRemoveWorktree

  ctx.pendingTeardowns?.set(state.loopName, {
    iteration: state.iteration,
    reasonLabel,
    doCommit,
    doRemoveWorktree: false,
  })

  await unwarpToHostSession(state, ctx)

  let removedWorkspace = false
  try {
    await ctx.client.workspace.remove({ id: state.workspaceId })
    removedWorkspace = true
    ctx.logger.log(`Loop: workspace ${state.workspaceId} removed for ${state.loopName}`)
  } catch (err) {
    ctx.logger.error(`Loop: workspace.remove threw for ${state.workspaceId}`, err)
  } finally {
    ctx.pendingTeardowns?.clear(state.loopName)
  }

  if (removedWorkspace && removeWorktreeAfterWorkspaceRemoval && state.worktreeDir) {
    const settleMs = resolveUnwarpSettleMs()
    if (settleMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, settleMs))
    }
    await cleanupLoopWorktree({
      worktreeDir: state.worktreeDir,
      logPrefix: 'Loop: post-workspace-remove',
      logger: ctx.logger,
    })
  }

  // Opportunistic sweep of stale sibling workspaces (port required)
  if (ctx.client && ctx.loopsRepo && ctx.projectId && ctx.pendingTeardowns && state.projectDir) {
    try {
      const report = await sweepStaleForgeWorkspaces(
        { client: ctx.client, loopsRepo: ctx.loopsRepo, pendingTeardowns: ctx.pendingTeardowns, logger: ctx.logger },
        { projectId: ctx.projectId, projectDirectory: state.projectDir, excludeLoopName: state.loopName, reasonLabel: 'orphan-sweep' },
      )
      if (report.swept.length > 0) {
        ctx.logger.log(`Loop: stale-workspace sweep removed ${report.swept.length} entries during teardown of ${state.loopName}`)
      }
      if (report.failed.length > 0) {
        ctx.logger.error(`Loop: stale-workspace sweep had ${report.failed.length} failure(s) during teardown of ${state.loopName}`, report.failed)
      }
    } catch (err) {
      ctx.logger.error(`Loop: stale-workspace sweep threw during teardown of ${state.loopName}`, err)
    }
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
    case 'worktree_failed':
    case 'provider_limit':
      return 'errored'
    case 'session_creation_failed':
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
