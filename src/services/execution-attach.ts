/**
 * Forge Execution Service - Attach + Session-Select Helpers
 *
 * Extracted from execution.ts. Contains the helpers responsible for binding a
 * freshly-created loop session to its persistent loop state and selecting the
 * worktree session in the TUI after warp. Types come from ./execution-types to
 * avoid any cycle back into the execution facade.
 */

import type { Logger } from '../types'
import { selectSessionBestEffort } from '../utils/tui-navigation'
import { parseModelString } from '../utils/model-fallback'
import { classifyProviderLimit, extractErrorSignal } from '../loop/provider-limit'
import { join } from 'path'
import { existsSync } from 'fs'
import { applyPlanDecomposition } from './section-bootstrap'
import { sendLoopPrompt } from '../loop/send-loop-prompt'
import { markPromptSent, isWorkspaceNotFoundError } from '../loop'
import { resolveHostSessionDirectory } from '../utils/resolve-project-root'

import type {
  ForgeExecutionRequestContext,
  AttachLoopInput,
  ForgeExecutionServiceDeps,
} from './execution-types'

/**
 * A freshly created + warped loop session can transiently report "Session not
 * found" (and, less often, "Workspace not found") before it is durably
 * registered — the `session.created` event lags the synchronous `create()`
 * return. Such failures are retryable; a real misconfiguration is not.
 */
export function isTransientSessionError(err: unknown): boolean {
  const msg = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : (() => { try { return JSON.stringify(err ?? '') } catch { return String(err) } })()
  return /Session not found/i.test(msg) || isWorkspaceNotFoundError(err)
}

// ============================================================================
// Session-select helper
// ============================================================================

export interface SelectInitialWorktreeSessionOpts {
  selectSession: boolean | undefined
  logger: Logger | Console
  workspaceStatusRegistry: import('../utils/workspace-status-registry').WorkspaceStatusRegistry
  selectSessionFn: (selection: { sessionID: string; workspace?: string }) => Promise<void>
  /** Maximum time to wait for selectSessionFn before falling through. Defaults to 2000ms. */
  selectTimeoutMs?: number
}

export async function selectInitialWorktreeSession(
  targetSessionId: string,
  boundWorkspaceId: string | undefined,
  context: string,
  opts: SelectInitialWorktreeSessionOpts,
): Promise<void> {
  opts.logger.log(`[warp] select.entry context="${context}" targetSessionId=${targetSessionId} workspaceId=${boundWorkspaceId ?? 'none'}`)

  if (!opts.selectSession) {
    opts.logger.log(`[warp] select.exit context="${context}" reason=no-select-session`)
    return
  }

  if (!boundWorkspaceId) {
    opts.logger.log(`[warp] select.exit context="${context}" reason=no-workspace`)
    return
  }

  const totalStart = Date.now()

  try {
    const connectedResult = await opts.workspaceStatusRegistry.awaitConnected(boundWorkspaceId, {
      timeoutMs: 5000,
      logger: opts.logger as Logger,
    })

    const readyElapsedMs = Date.now() - totalStart

    if (connectedResult.connected) {
      opts.logger.log(
        `[warp] select.ready context="${context}" source=${connectedResult.source} elapsedMs=${readyElapsedMs}`,
      )
    } else {
      opts.logger.log(
        `[warp] select.degraded context="${context}" reason="${connectedResult.reason ?? 'unknown'}" lastStatus="${connectedResult.lastStatus ?? 'none'}" elapsedMs=${readyElapsedMs}`,
      )
    }

    const envTimeout = Number(process.env.FORGE_SELECT_TIMEOUT_MS)
    const SELECT_TIMEOUT_MS = opts.selectTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 2000)
    await Promise.race([
      opts.selectSessionFn({ sessionID: targetSessionId, workspace: boundWorkspaceId }),
      new Promise<void>((resolve) => setTimeout(resolve, SELECT_TIMEOUT_MS)),
    ])
    const totalMs = Date.now() - totalStart
    opts.logger.log(`[warp] select.complete context="${context}" totalMs=${totalMs}`)
  } catch (err) {
    const totalMs = Date.now() - totalStart
    opts.logger.error(
      `[warp] select.failed context="${context}" error="${err instanceof Error ? err.message : String(err)}" totalMs=${totalMs}`,
    )
  }
}

// ============================================================================
// attachLoopToSession
// ============================================================================

export async function attachLoopToSession(
  deps: ForgeExecutionServiceDeps,
  ctx: ForgeExecutionRequestContext,
  input: AttachLoopInput,
): Promise<{ ok: true; loopName: string } | { ok: false; code: 'already_attached' | 'conflict' | 'internal_error' | 'prompt_failed' | 'provider_limit'; message: string }> {
  const {
    sessionId,
    workspaceId,
    worktreeDir,
    worktreeBranch,
    loopName,
    displayName,
    executionModel,
    auditorModel,
    executionVariant,
    auditorVariant,
    maxIterations,
    sandboxEnabled,
    sandboxContainer,
    planText,
    selectSession,
    selectSessionTiming,
    startWatchdog,
    sendInitialPrompt = true,
    abortSourceSessionOnSuccess,
    onStarted,
    kind,
    goal,
    executorSessionId,
  } = input
  const isGoal = kind === 'goal'

  const loopModel = parseModelString(executionModel)

  const existing = deps.loopsRepo.get(ctx.projectId, loopName)
  if (existing) {
    if (existing.status === 'running') {
      deps.logger.log(`attachLoopToSession: loop ${loopName} already attached (running), skipping`)
      return { ok: false, code: 'already_attached', message: `Loop ${loopName} is already attached` }
    }
    deps.logger.log(`attachLoopToSession: loop ${loopName} has terminal status ${existing.status}; refusing attach`)
    return { ok: false, code: 'conflict', message: `Loop ${loopName} is terminal. Use loop restart to resume or start a new suffixed loop.` }
  }

  // Defensive purge of orphaned per-loop rows (section_plans cascade may not have fired
  // historically; plans/review_findings have no FK). Idempotent.
  try {
    const removedSections = deps.sectionPlansRepo?.deleteAll(ctx.projectId, loopName) ?? 0
    deps.plansRepo.deleteForLoop(ctx.projectId, loopName)
    deps.reviewFindingsRepo?.deleteByLoopName(ctx.projectId, loopName)
    if (removedSections > 0) {
      deps.logger.log(`attachLoopToSession: purged ${removedSections} orphaned section_plans rows for ${loopName}`)
    }
  } catch (err) {
    deps.logger.error(`attachLoopToSession: failed to purge orphaned per-loop rows for ${loopName}`, err)
    // Non-fatal — proceed.
  }

  // The plugin instance handling this tool call may be bound to a worktree
  // directory, so ctx.directory is not a reliable project root. Resolve the
  // real project directory from the host session that launched the loop, and
  // only fall back to ctx.directory when that lookup is unavailable.
  const resolvedProjectDir =
    (await resolveHostSessionDirectory(deps.client, input.hostSessionId, ctx.directory, deps.logger)) ?? ctx.directory

  try {
    // Persist loop state
    const state: import('../loop/state').LoopState = {
      active: true,
      sessionId,
      loopName,
      worktreeDir: worktreeDir ?? ctx.directory,
      projectDir: resolvedProjectDir,
      worktreeBranch,
      iteration: 1,
      maxIterations,
      startedAt: new Date().toISOString(),
      prompt: isGoal ? undefined : planText,
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      status: 'running',
      worktree: true,
      sandbox: sandboxEnabled,
      sandboxContainer: sandboxContainer ?? undefined,
      executionModel,
      auditorModel,
      executionVariant,
      auditorVariant,
      workspaceId,
      hostSessionId: input.hostSessionId,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      ...(isGoal ? { kind: 'goal' as const, goal, executorSessionId } : {}),
    }

    deps.loop.service.setState(loopName, state)
    deps.loop.service.registerLoopSession(sessionId, loopName)
    deps.loop.registerSessionReverseIndex(sessionId, loopName)

    deps.logger.log(`attachLoopToSession: state stored for loop=${loopName}`)

    onStarted?.({
      sessionId,
      loopName,
      displayName,
      worktreeDir,
      workspaceId,
    })

    // === Initial prompt ===
    let promptText: string
    if (isGoal) {
      // Goal loops have no sections; the initial prompt is the same goal
      // continuation prompt used on every later iteration.
      promptText = deps.loop.service.buildContinuationPrompt(state)
    } else {
      const { totalSections } = applyPlanDecomposition({
        projectId: ctx.projectId,
        loopName,
        planText,
        loopsRepo: deps.loopsRepo,
        sectionPlansRepo: deps.sectionPlansRepo,
      })
      if (totalSections > 0) {
        const updatedState = { ...state, phase: 'coding' as const, currentSectionIndex: 0, totalSections }
        promptText = deps.loop.service.buildSectionInitialPrompt(updatedState as import('../loop/state').LoopState)
      } else {
        promptText = planText
      }
    }

    // Wait for sandbox readiness in worktree+sandbox mode (after persistence)
    if (sandboxEnabled && deps.sandboxManager && deps.dataDir) {
      const dbPath = join(deps.dataDir, 'forge.db')
      if (existsSync(dbPath)) {
        const { waitForSandboxReady } = await import('../utils/sandbox-ready')
        const waitResult = await waitForSandboxReady({
          projectId: ctx.projectId,
          loopName,
          dbPath,
          pollMs: 200,
          timeoutMs: 15_000,
        })

        if (!waitResult.ready) {
          deps.logger.error(`attachLoopToSession: sandbox not ready (${waitResult.reason})`)
          try {
            const { createDockerService } = await import('../sandbox/docker')
            const docker = createDockerService(deps.logger as unknown as Console)
            const cn = docker.containerName(loopName)
            if (await docker.isRunning(cn)) {
              await docker.removeContainer(cn)
            }
          } catch (cleanupErr) {
            deps.logger.error('attachLoopToSession: failed to remove sandbox container after timeout', cleanupErr)
          }
          deps.loop.unregisterSessionReverseIndex(sessionId)
          deps.loop.service.deleteState(loopName)
          return { ok: false, code: 'internal_error', message: `Sandbox not ready: ${waitResult.reason}` }
        }

        deps.logger.log(`attachLoopToSession: sandbox ready (${waitResult.containerName})`)
      }
    }

    // Navigate TUI if requested with early timing
    if (selectSession && selectSessionTiming === 'after-create') {
      const selection = workspaceId
        ? { workspace: workspaceId, sessionID: sessionId }
        : { sessionID: sessionId }

      selectSessionBestEffort(deps.client, deps.directory, deps.logger, selection).catch((err: unknown) => {
        deps.logger.error('attachLoopToSession: failed to navigate TUI (early)', err as Error)
      })
    }

    if (!sendInitialPrompt) {
      if (startWatchdog && deps.loopHandler) {
        deps.loopHandler.startWatchdog(loopName)
      }
      deps.logger.log(`attachLoopToSession: attached loop=${loopName} without sending initial prompt`)
      return { ok: true, loopName }
    }

    // Send initial prompt with fallback
    const sessionDir = worktreeDir
    const promptParts = [{ type: 'text' as const, text: promptText }]
    const workspaceParam = workspaceId ? { workspace: workspaceId } : {}

    const promptResult = await sendLoopPrompt({
      loopName,
      sessionId,
      agent: 'code',
      logger: deps.logger,
      primaryModel: loopModel,
      useInFlightGuard: false,
      performPrompt: async (model) => {
        markPromptSent(loopName, sessionId, deps.logger)
        try {
          await deps.client.session.promptAsync({
            sessionID: sessionId,
            directory: sessionDir,
            parts: promptParts,
            agent: 'code',
            ...workspaceParam,
            ...(model ? { model } : {}),
          })
          return {}
        } catch (err) {
          return { error: err }
        }
      },
    })

    if (promptResult.result.error) {
      const limitReason = classifyProviderLimit(extractErrorSignal(promptResult.result.error))
      if (limitReason) {
        deps.logger.error('attachLoopToSession: initial prompt hit provider limit, terminating loop', promptResult.result.error)
        await deps.loop.terminate(loopName, { kind: 'provider_limit', message: limitReason })
        return { ok: false, code: 'provider_limit', message: `Provider limit on initial prompt: ${limitReason}` }
      }
      deps.logger.error('attachLoopToSession: failed to send prompt', promptResult.result.error)
      deps.loop.unregisterSessionReverseIndex(sessionId)
      deps.loop.service.deleteState(loopName)
      return { ok: false, code: 'prompt_failed', message: 'Loop session created but failed to send prompt' }
    }

    // Success: start watchdog if requested
    if (startWatchdog && deps.loopHandler) {
      deps.loopHandler.startWatchdog(loopName)
    }

    // Navigate TUI if requested with default/post-prompt timing
    if (selectSession && selectSessionTiming !== 'after-create') {
      const selection = workspaceId
        ? { workspace: workspaceId, sessionID: sessionId }
        : { sessionID: sessionId }

      selectSessionBestEffort(deps.client, deps.directory, deps.logger, selection).catch((err: unknown) => {
        deps.logger.error('attachLoopToSession: failed to navigate TUI', err as Error)
      })
    }

    // Abort source session if requested
    if (abortSourceSessionOnSuccess && ctx.sourceSessionId) {
      deps.client.session.abort({ sessionID: ctx.sourceSessionId }).catch((err: unknown) => {
        deps.logger.error('attachLoopToSession: failed to abort source session', err as Error)
      })
    }

    return { ok: true, loopName }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isAlreadyExists = msg.includes('already exists') || msg.includes('UNIQUE constraint failed')
    deps.logger.error('attachLoopToSession: unexpected error', err)
    if (!isAlreadyExists) {
      deps.loop.unregisterSessionReverseIndex(sessionId)
      deps.loop.service.deleteState(loopName)
    } else {
      deps.logger.log(`attachLoopToSession: preserving existing loop ${loopName} despite collision`)
    }
    return {
      ok: false,
      code: isAlreadyExists ? 'already_attached' : 'internal_error',
      message: isAlreadyExists ? `Loop ${loopName} already attached` : 'Failed to attach loop to session',
    }
  }
}
