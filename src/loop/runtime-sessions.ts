import type { RuntimeContext } from './runtime-context'
import type { TransitionLog, TransitionLogEntry } from './runtime-transition-log'
import type { PromptDispatch } from './runtime-prompt'
import type { UsageCapture } from './runtime-usage'
import type { WorkspaceLifecycle } from './runtime-workspace'
import type { PromptRetry } from './runtime-retry'
import type { ForgeClient } from '../client/port'
import type { Logger, PluginConfig } from '../types'
import type { LoopState } from './state'
import { transitionSectionIndex } from './state'
import { clearPromptPending } from './idle-gate'
import { buildLoopPermissionRuleset, resolveLoopAllowedDirectories } from '../constants/loop'
import { createLoopSessionWithWorkspace } from '../utils/loop-session'
import { formatLoopSessionTitle } from '../utils/session-titles'
import { resolveLoopModel } from '../utils/loop-helpers'
import { selectSessionBestEffort } from '../utils/tui-navigation'

const SESSION_RETENTION = 0

export interface SessionLifecycle {
  resolveSessionLoopName(sessionId: string): Promise<string | null>
  rotateSession(
    loopName: string,
    state: LoopState,
    titleContext?: { iteration?: number; currentSectionIndex?: number },
  ): Promise<string>
  scheduleSessionDelete(input: {
    loopName: string
    sessionId: string
    directory: string
    context: string
    phase?: LoopState['phase']
    state?: LoopState
  }): Promise<void>
  rotateAndSendContinuation(
    loopName: string,
    currentState: LoopState,
    stateUpdates: Partial<LoopState>,
    continuationPrompt: string,
    assistantErrorDetected: boolean,
    errorContext: string,
    transition?: TransitionLogEntry,
  ): Promise<void>
  rotateToCodingAfterAuditFailure(loopName: string, state: LoopState, reason: string, eventType: string): Promise<void>
  setParentSessionLookup(lookup: (sessionId: string) => Promise<string | null>): void
}

export interface SessionLifecycleDeps {
  ctx: RuntimeContext
  logger: Logger
  getConfig: () => PluginConfig
  client: ForgeClient
  getParentSessionId?: (sessionId: string) => Promise<string | null>
  promptDispatch: PromptDispatch
  usageCapture: UsageCapture
  workspace: WorkspaceLifecycle
  promptRetry: PromptRetry
  transitionLog: TransitionLog
}

export function createSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycle {
  const { ctx, logger, getConfig, client, promptDispatch, usageCapture, workspace, promptRetry, transitionLog } = deps
  const { ensureWorkspaceForLoop, detachFromWorkspace } = workspace
  const { sendPromptWithFallback } = promptDispatch
  const { handlePromptError, sendPromptWithRetryRecovery } = promptRetry
  const { recordTransitionEntry } = transitionLog
  let getParentSessionId = deps.getParentSessionId

  /**
   * Resolve a session ID to its owning loop name, checking the DB index,
   * the in-memory reverse index, and (optionally) the ancestor chain.
   * The ancestor walk handles child/subagent sessions whose parent is the
   * registered loop session.
   */
  async function resolveSessionLoopName(sessionId: string): Promise<string | null> {
    const direct = ctx.loopService.resolveLoopName(sessionId)
    if (direct) return direct

    const fromReverse = ctx.sessionToLoop.get(sessionId)
    if (fromReverse) return fromReverse

    if (!getParentSessionId) return null

    const seen = new Set<string>([sessionId])
    let current = sessionId
    for (let depth = 0; depth < 10; depth++) {
      const parentId = await getParentSessionId(current)
      if (!parentId || seen.has(parentId)) break
      seen.add(parentId)

      const parentLoop = ctx.loopService.resolveLoopName(parentId)
      if (parentLoop) return parentLoop

      const parentReverse = ctx.sessionToLoop.get(parentId)
      if (parentReverse) return parentReverse

      current = parentId
    }

    return null
  }

  /**
   * Rotates to a new session in the same workspace. Creates and binds the new session FIRST,
   * then fire-and-forget deletes the old session. This ordering ensures the workspace always
   * has at least one bound session, preventing the host from pruning it from non-focused TUIs.
   */
  async function rotateSession(
    loopName: string,
    state: LoopState,
    titleContext?: { iteration?: number; currentSectionIndex?: number },
  ): Promise<string> {
    const oldSessionId = state.sessionId
    const sessionDir = state.worktreeDir

    clearPromptPending(loopName, logger)

    logger.log(
      `Loop: [perm-diag] rotate loop=${loopName} state.worktree=${String(state.worktree)} state.sandbox=${String(state.sandbox)}`
    )

    const permissionRuleset = buildLoopPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories(getConfig()) })

    const ensured = await ensureWorkspaceForLoop(loopName, state, 'during session rotation')

    const createResult = await createLoopSessionWithWorkspace({
      client: client,
      title: formatLoopSessionTitle(state.loopName, {
        iteration: titleContext?.iteration ?? state.iteration ?? 0,
        currentSectionIndex: titleContext?.currentSectionIndex ?? state.currentSectionIndex ?? 0,
        totalSections: state.totalSections ?? 0,
      }),
      directory: sessionDir,
      permission: permissionRuleset,
      workspaceId: ensured.workspaceId ?? state.workspaceId,
      loopName: loopName,
      logPrefix: 'Loop',
      logger,
    })

    if (!createResult) {
      throw new Error('Failed to create new session.')
    }

    const newSessionId = createResult.sessionId

    if (createResult.bindFailed) {
      detachFromWorkspace(loopName, state, 'during session rotation')
    }

    const oldRetryTimeout = ctx.retryTimeouts.get(loopName)
    if (oldRetryTimeout) {
      clearTimeout(oldRetryTimeout)
      ctx.retryTimeouts.delete(loopName)
    }

    ctx.loopService.registerLoopSession(newSessionId, loopName)
    ctx.sessionToLoop.set(newSessionId, loopName)
    // Retain the old session in the reverse index so delayed errors from the
    // pre-rotation session still resolve to this loop after DB-level replacement.
    ctx.sessionToLoop.set(oldSessionId, loopName)

    await selectSessionBestEffort(client, state.projectDir ?? state.worktreeDir, logger, {
      sessionID: newSessionId,
      workspace: ensured.workspaceId ?? state.workspaceId,
    })

    ctx.watchdog.stop(loopName)
    ctx.watchdog.start(loopName)

    void scheduleSessionDelete({ loopName, sessionId: oldSessionId, directory: sessionDir, context: 'after session rotation', phase: state.phase, state })

    logger.log(`Loop: rotated session ${oldSessionId} → ${newSessionId}`)

    return newSessionId
  }

  async function scheduleSessionDelete(input: {
    loopName: string
    sessionId: string
    directory: string
    context: string
    phase?: LoopState['phase']
    state?: LoopState
  }): Promise<void> {
    const { loopName, sessionId, directory, context, phase, state } = input
    const queue = ctx.loopRetainedSessions.get(loopName) ?? []

    // Check if already queued by sessionId
    if (queue.some(entry => entry.sessionId === sessionId)) return

    // Determine role and fallback model at queue time
    const role: 'code' | 'auditor' = phase && (phase === 'auditing' || phase === 'final_auditing') ? 'auditor' : 'code'
    const fallbackModel = phase && state ? usageCapture.getFallbackModelForSession(state, phase) : undefined

    queue.push({ sessionId, role, fallbackModel, directory })
    ctx.loopRetainedSessions.set(loopName, queue)
    logger.debug(`Loop: queued session ${sessionId} for retention (loop=${loopName}, context=${context}, queue=${queue.length})`)

    while (queue.length > SESSION_RETENTION) {
      const oldest = queue.shift()!
      logger.log(`Loop: trimming session ${oldest.sessionId} (loop=${loopName}, retention=${SESSION_RETENTION})`)

      // Capture usage before deletion using stored metadata
      await usageCapture.captureLoopSessionUsage({
        loopName,
        sessionId: oldest.sessionId,
        directory: oldest.directory,
        role: oldest.role,
        fallbackModel: oldest.fallbackModel,
      })

      void client.session.delete({ sessionID: oldest.sessionId, directory: oldest.directory }).catch((err: unknown) => {
        logger.error(`Loop: failed to delete trimmed session ${oldest.sessionId} (loop=${loopName})`, err)
      })
    }
  }

  /**
   * Shared: rotate session and send continuation prompt with model fallback.
   *
   * When `transition` is supplied, the non-terminal transition row is recorded
   * AFTER `replaceSession` (the persisted phase commit) and BEFORE the prompt
   * send. This ordering is intentional: it leaves no phantom row if persistence
   * somehow fails, and it guarantees the transition row's id precedes any
   * terminate row produced by a downstream prompt-send failure (chronological
   * id order).
   */
  async function rotateAndSendContinuation(
    loopName: string,
    currentState: LoopState,
    stateUpdates: Partial<LoopState>,
    continuationPrompt: string,
    assistantErrorDetected: boolean,
    errorContext: string,
    transition?: TransitionLogEntry,
  ): Promise<void> {
    let activeSessionId = currentState.sessionId
    try {
      activeSessionId = await rotateSession(loopName, currentState, {
        iteration: stateUpdates.iteration ?? currentState.iteration,
        currentSectionIndex: stateUpdates.currentSectionIndex ?? currentState.currentSectionIndex,
      })
    } catch (err) {
      logger.error(`Loop: session rotation failed, continuing with existing session`, err)
    }

    ctx.loopService.replaceSession(loopName, {
      newSessionId: activeSessionId,
      phase: stateUpdates.phase ?? 'coding',
      iteration: stateUpdates.iteration ?? currentState.iteration,
      resetError: !assistantErrorDetected && currentState.errorCount > 0,
      auditCount: stateUpdates.auditCount,
      lastAuditResult: stateUpdates.lastAuditResult ?? null,
      ...(currentState.kind === 'goal' ? { executorSessionId: activeSessionId } : {}),
    })

    if (transition) {
      // Record using the pre-transition state's iteration/sectionIndex so the
      // row reflects the "from" side of the phase change (consistent with
      // logTransition, which always uses `state.iteration`/`state.sectionIndex`
      // from the prior LoopState). The post-persist phase is captured by
      // `transition.toPhase`.
      recordTransitionEntry(loopName, currentState, transition)
    }

    const nextIteration = stateUpdates.iteration ?? currentState.iteration
    logger.log(`Loop iteration ${nextIteration} for session ${activeSessionId}`)

    const currentConfig = getConfig()
    const loopModel = resolveLoopModel(currentConfig, ctx.loopService, loopName)
    if (!loopModel) {
      logger.log(`Loop: configured model previously failed, using default model`)
    }

    const { sent, usedModel } = await sendPromptWithRetryRecovery({
      loopName,
      sessionId: activeSessionId,
      promptText: continuationPrompt,
      agent: 'code',
      model: loopModel,
      variant: currentState.executionVariant,
      errorContext,
      sendErrorContext: `failed to send continuation prompt ${errorContext}`,
      errorState: currentState,
      activityTag: 'phase-activity',
    })
    if (!sent) return
    if (usedModel) {
      logger.log(`${errorContext} using model: ${usedModel.providerID}/${usedModel.modelID}`)
    } else {
      logger.log(`${errorContext} using default model (fallback)`)
    }
  }

  async function rotateToCodingAfterAuditFailure(loopName: string, state: LoopState, reason: string, eventType: string): Promise<void> {
    const newSessionId = await rotateSession(loopName, state)

    ctx.loopService.replaceSession(loopName, {
      newSessionId,
      phase: 'coding',
      resetError: false,
      ...(state.kind === 'goal' ? { executorSessionId: newSessionId } : {}),
    })
    // Record the recovery transition AFTER the persisted phase commit to coding
    // so the abort/error → coding phase change is captured consistently.
    ctx.loopService.recordTransition(loopName, {
      eventType,
      transitionKind: 'error-recovery',
      fromPhase: state.phase,
      toPhase: 'coding',
      iteration: state.iteration ?? 0,
      sectionIndex: transitionSectionIndex(state),
    })
    ctx.loopService.setLastAuditResult(loopName, state.lastAuditResult ?? '')
    const isModelError = /provider|auth|model|api\s*error/i.test(reason)
    if (isModelError) {
      ctx.loopService.setModelFailed(loopName, true)
    }
    const continuationPrompt = ctx.loopService.buildContinuationPrompt(
      { ...state, iteration: state.iteration ?? 0 },
      `\n[Auditor session failed: ${reason}. Continuing without new findings.]`,
    )

    const loopModel = resolveLoopModel(getConfig(), ctx.loopService, loopName)
    const { error } = await sendPromptWithFallback({
      loopName,
      sessionId: newSessionId,
      promptText: continuationPrompt,
      agent: 'code',
      model: loopModel,
      variant: state.executionVariant,
    })
    if (error) {
      await handlePromptError(loopName, ctx.loopService.getActiveState(loopName) ?? state, 'rotateToCodingAfterAuditFailure: failed to send continuation prompt', error)
    }
  }

  function setParentSessionLookup(lookup: (sessionId: string) => Promise<string | null>): void {
    getParentSessionId = lookup
  }

  return {
    resolveSessionLoopName,
    rotateSession,
    scheduleSessionDelete,
    rotateAndSendContinuation,
    rotateToCodingAfterAuditFailure,
    setParentSessionLookup,
  }
}
