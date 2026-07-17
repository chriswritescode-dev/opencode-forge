import type { ForgeClient } from '../client/port'
import type { LoopChangeNotifier, LoopService } from './service'
import { createLoopService, MAX_RETRIES } from './service'
import { generateUniqueName } from './name-uniqueness'
import type { LoopState } from './state'
import type { Logger, PluginConfig, LoopConfig } from '../types'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo, ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { LoopEventsRepo } from '../storage/repos/loop-events-repo'
import type { LoopRunsRepo } from '../storage/repos/loop-runs-repo'
import { createLoopMetricsRecorder } from './metrics'
import { createLoopWatchdog, type LoopWatchdogStallInfo, type LoopWatchdogRecoveryContext } from '../hooks/watchdog'
import { resolveLoopModel, resolveLoopAuditorModel } from '../utils/loop-helpers'
import { parseModelString } from '../utils/model-fallback'
import type { createSandboxManager } from '../sandbox/manager'
// worktree-completion imports moved to hooks/loop.ts (termination side-effects)
import { buildLoopPermissionRuleset, resolveLoopAllowedDirectories } from '../constants/loop'
import { createLoopSessionWithWorkspace } from '../utils/loop-session'
// worktree-cleanup imports moved to hooks/loop.ts (termination side-effects)
import { createAuditSession, promptAuditSession } from '../utils/audit-session'
import { formatLoopSessionTitle, formatPostActionSessionTitle } from '../utils/session-titles'
import { clearPromptPending, sessionsAwaitingBusy, isAwaitingBusy, isAwaitingBusyExpired } from './idle-gate'
import {
  clearPromptInFlight,
  clearPromptInFlightBySession,
  withInFlightGuard,
  ConcurrentPromptError,
} from './in-flight-guard'
import type { TerminationReason } from './termination'
import { terminationStatusFor, terminationReasonToString } from './termination'
import { nextTransition } from './transitions'
import { createUsageCapture } from './runtime-usage'
import { createPromptDispatch } from './runtime-prompt'
import { createWorkspaceLifecycle, isWorkspaceNotFoundError } from './runtime-workspace'
import { loopRegistry } from '../utils/loop-registry'
import { selectSessionBestEffort } from '../utils/tui-navigation'

import { classifyProviderLimit, extractErrorSignal } from './provider-limit'
import { parseCoderDecisions } from '../utils/coder-decisions'
import { resolvePostActionConfig } from './post-action-config'

export interface LoopEvent {
  type: string
  properties?: Record<string, unknown>
}

/**
 * Callback invoked after the core state-machine portion of termination completes.
 * Host-specific side-effects (teardown, toast, completion-log, sandbox-stop) live here.
 */
export type OnTerminatedCallback = (state: LoopState, reason: TerminationReason) => Promise<void>

export interface LoopRuntimeDeps {
  loopsRepo: LoopsRepo
  plansRepo: PlansRepo
  reviewFindingsRepo: ReviewFindingsRepo
  projectId: string
  client: ForgeClient
  logger: Logger
  getConfig: () => PluginConfig
  sandboxManager?: ReturnType<typeof createSandboxManager>
  dataDir?: string
  onTerminated?: OnTerminatedCallback
  notify?: LoopChangeNotifier
  loopConfig?: LoopConfig
  sectionPlansRepo?: SectionPlansRepo
  loopSessionUsageRepo?: LoopSessionUsageRepo
  loopEventsRepo?: LoopEventsRepo
  loopRunsRepo?: LoopRunsRepo
  /** Optional injected LoopService (test seam). Defaults to a real one built from the repos. */
  loopService?: LoopService
  /** Optional parent-session lookup for ancestor-aware session→loop resolution (child/subagent support). */
  getParentSessionId?: (sessionId: string) => Promise<string | null>
}

export interface StartLoopInput {
  state: LoopState
}

export interface Loop {
  tick(event: LoopEvent): Promise<void>
  start(input: StartLoopInput): void
  cancel(name: string): Promise<void>
  inspect(name: string): LoopState | null
  listActive(): LoopState[]
  listRecent(): LoopState[]
  findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] }
  hasOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): boolean
  terminateAll(): Promise<void>
  terminate(name: string, reason: TerminationReason): Promise<boolean>
  cancelBySessionId(sessionId: string): Promise<boolean>
  runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T>
  clearLoopTimers(name: string): Promise<void>
  clearAllRetryTimeouts(): void
  recordActivity(name: string, source?: string): void
  startWatchdog(name: string): void
  getStallInfo(name: string): LoopWatchdogStallInfo | null
  restart(name: string, params: { newState: LoopState; newSessionId: string }): void
  /**
   * Capture the outgoing active run's usage and record its termination metrics
   * (loop_terminated event + loop_runs summary) before a restart replaces the
   * loop row. Deliberately skips loopService.terminate and watchdog/timer
   * teardown — the restart caller already cleared timers and will replace the
   * loop row directly via loopsRepo.restart. Non-fatal: any failure is logged.
   */
  finalizeRunForRestart(name: string, reason: TerminationReason): Promise<void>
  generateUniqueLoopName(baseName: string): string
  /** Transition a running loop's phase. */
  setPhase(name: string, phase: LoopState['phase']): void
  /**
   * Populate the in-memory reverse index for a session that was registered
   * through a path that does not call {@link start} (e.g. production execution
   * service via {@link attachLoopToSession}). This ensures stale-session error
   * events can still resolve their loop after session rotation.
   */
  registerSessionReverseIndex(sessionId: string, loopName: string): void
  /**
   * Remove a session from the in-memory reverse index. Called during rollback
   * when attach or restart fails so that delayed errors from the orphaned session
   * cannot terminate a later loop that reuses the same name.
   */
  unregisterSessionReverseIndex(sessionId: string): void
  /**
   * Wire the parent-session lookup for ancestor-aware session→loop resolution.
   * Called after construction because the lookup depends on the Loop instance itself.
   */
  setParentSessionLookup(lookup: (sessionId: string) => Promise<string | null>): void
  /** Access the underlying LoopService for state/prompt/section operations. */
  service: LoopService
}

export { isWorkspaceNotFoundError } from './runtime-workspace'

export function createLoop(deps: LoopRuntimeDeps): Loop {
  const { loopsRepo, plansRepo, reviewFindingsRepo, projectId, client, logger, getConfig, onTerminated, notify, loopConfig, sectionPlansRepo, loopSessionUsageRepo, loopEventsRepo, loopRunsRepo } = deps
  const loopService = deps.loopService ?? createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger, loopConfig, notify, sectionPlansRepo)
  let getParentSessionId = deps.getParentSessionId

  const { getFallbackModelForSession, captureLoopSessionUsage } = createUsageCapture({ client, logger, getConfig, projectId, loopSessionUsageRepo })

  const metrics = createLoopMetricsRecorder({ client, logger, projectId, loopEventsRepo, loopRunsRepo, loopSessionUsageRepo })

  const { sendPromptWithFallback, getLastAssistantInfo, getAssistantTranscript } = createPromptDispatch({ client, logger, getConfig, loopService })

  const retryTimeouts = new Map<string, NodeJS.Timeout>()
  const idleRetryTimeouts = new Map<string, NodeJS.Timeout>()
  const idleRetryAttempts = new Map<string, number>()
  const stateLocks = new Map<string, Promise<unknown>>()

  const IDLE_RETRY_DELAY_MS = 1500
  const MAX_IDLE_RETRIES = 1
  const MAX_CODE_LAUNCH_RECOVERIES = MAX_RETRIES

  const codingLaunchRecoveryAttempts = new Map<string, number>()
  // Loops currently in "fix → re-final-audit" mode. When a final audit comes back dirty
  // we rotate to a coding session with the findings, then on coding idle we transition
  // straight back to final_auditing (skipping the per-section audit).
  const pendingFinalAuditFix = new Set<string>()
  interface RetainedSessionMeta {
    sessionId: string
    role: 'code' | 'auditor'
    fallbackModel: string | undefined
    directory: string
    /**
     * Ms-epoch of the loop's started_at at queue time. Replayed into the
     * usage capture call so the persisted row stamps its run identity.
     */
    runStartedAt: number
  }
  const loopRetainedSessions = new Map<string, RetainedSessionMeta[]>()
  /**
   * In-flight usage-capture promises keyed by loop. scheduleSessionDelete
   * trims sessions outside the (0-length) retention window via a fire-and-
   * forget async path, so the trimmed session is removed from
   * loopRetainedSessions before its capture finishes. terminateLoop reads the
   * retain queue and would miss those mid-trim captures, recording the run
   * summary before the usage row lands and permanently undercounting the run.
   * Tracking the pending captures here lets terminateLoop await them before
   * writing loop_runs, so the aggregate reflects every session in the run.
   */
  const loopPendingUsageCaptures = new Map<string, Set<Promise<unknown>>>()
  function trackUsageCapture(loopName: string, promise: Promise<unknown>): void {
    let set = loopPendingUsageCaptures.get(loopName)
    if (!set) {
      set = new Set()
      loopPendingUsageCaptures.set(loopName, set)
    }
    set.add(promise)
    void promise.finally(() => {
      const current = loopPendingUsageCaptures.get(loopName)
      if (!current) return
      current.delete(promise)
      if (current.size === 0) loopPendingUsageCaptures.delete(loopName)
    })
  }
  async function awaitPendingUsageCaptures(loopName: string): Promise<void> {
    const set = loopPendingUsageCaptures.get(loopName)
    if (!set || set.size === 0) return
    await Promise.all([...set])
  }
  const SESSION_RETENTION = 0
  const sessionToLoop = new Map<string, string>()
  /** Per-loop admission guard: prevents concurrent terminateLoop calls from executing side effects twice. */
  const terminatingLoops = new Set<string>()
  function withStateLock<T>(loopName: string, fn: () => Promise<T>): Promise<T> {
    const prev = stateLocks.get(loopName) ?? Promise.resolve()
    const nextPromise = prev.catch(() => undefined).then(() => fn())
    stateLocks.set(loopName, nextPromise)
    void nextPromise.finally(() => {
      if (stateLocks.get(loopName) === nextPromise) {
        stateLocks.delete(loopName)
      }
    })
    return nextPromise
  }

  /**
   * Resolve a session ID to its owning loop name, checking the DB index,
   * the in-memory reverse index, and (optionally) the ancestor chain.
   * The ancestor walk handles child/subagent sessions whose parent is the
   * registered loop session.
   */
  async function resolveSessionLoopName(sessionId: string): Promise<string | null> {
    const direct = loopService.resolveLoopName(sessionId)
    if (direct) return direct

    const fromReverse = sessionToLoop.get(sessionId)
    if (fromReverse) return fromReverse

    if (!getParentSessionId) return null

    const seen = new Set<string>([sessionId])
    let current = sessionId
    for (let depth = 0; depth < 10; depth++) {
      const parentId = await getParentSessionId(current)
      if (!parentId || seen.has(parentId)) break
      seen.add(parentId)

      const parentLoop = loopService.resolveLoopName(parentId)
      if (parentLoop) return parentLoop

      const parentReverse = sessionToLoop.get(parentId)
      if (parentReverse) return parentReverse

      current = parentId
    }

    return null
  }

  const { detachFromWorkspace, recoverFromMissingWorkspace, ensureWorkspaceForLoop } = createWorkspaceLifecycle({ client, logger, loopService })

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

    const oldRetryTimeout = retryTimeouts.get(loopName)
    if (oldRetryTimeout) {
      clearTimeout(oldRetryTimeout)
      retryTimeouts.delete(loopName)
    }

    loopService.registerLoopSession(newSessionId, loopName)
    sessionToLoop.set(newSessionId, loopName)
    // Retain the old session in the reverse index so delayed errors from the
    // pre-rotation session still resolve to this loop after DB-level replacement.
    sessionToLoop.set(oldSessionId, loopName)

    await selectSessionBestEffort(client, state.projectDir ?? state.worktreeDir, logger, {
      sessionID: newSessionId,
      workspace: ensured.workspaceId ?? state.workspaceId,
    })

    watchdog.stop(loopName)
    watchdog.start(loopName)

    void scheduleSessionDelete({ loopName, sessionId: oldSessionId, directory: sessionDir, context: 'after session rotation', phase: state.phase, state })

    logger.log(`Loop: rotated session ${oldSessionId} → ${newSessionId}`)

    return newSessionId
  }

  /**
   * Shared: handle assistant error detection and model failure.
   * Returns null if the loop was terminated (caller should return).
   * Returns updated { assistantErrorDetected, currentState }.
   */
  async function detectAndHandleAssistantError(
    loopName: string,
    currentState: LoopState,
    assistantError: string | null,
    phase: string,
    errorSignal?: { name?: string; message?: string; statusCode?: number } | null,
  ): Promise<{ assistantErrorDetected: boolean; currentState: LoopState } | null> {
    if (!assistantError) {
      return { assistantErrorDetected: false, currentState }
    }

    logger.error(`Loop: assistant error detected in ${phase} phase: ${assistantError}`)

    const limitReason = classifyProviderLimit(errorSignal ?? {})
    if (limitReason) {
      logger.error(`Loop: provider limit detected in ${phase} assistant error for ${loopName}: ${limitReason}, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
      return null
    }

    const isModelError = /provider|auth|model|api\s*error/i.test(assistantError)
    if (isModelError) {
      const nextErrorCount = loopService.incrementError(loopName)
      if (nextErrorCount >= MAX_RETRIES) {
        await terminateLoop(loopName, currentState, { kind: 'error_max_retries', message: `assistant error: ${assistantError}` })
        return null
      }
      loopService.setModelFailed(loopName, true)
      logger.log(`Loop: marking model as failed, will fall back to default model (error ${nextErrorCount}/${MAX_RETRIES})`)
      return { assistantErrorDetected: true, currentState: loopService.getActiveState(loopName)! }
    }

    return { assistantErrorDetected: true, currentState }
  }

  /**
   * Shared: check audit clear and terminate if ready.
   * Returns true if the loop was terminated (caller should return).
   */
  async function checkAuditClearAndTerminate(
    loopName: string,
    currentState: LoopState,
  ): Promise<boolean> {
    logger.debug(`Loop: checking audit clear loop=${loopName} auditCount=${currentState.auditCount ?? 0} loopName=${currentState.loopName ?? '(none)'}`)
    if ((currentState.auditCount ?? 0) < 1) {
      logger.debug(`Loop: audit clear gate blocked by auditCount<1`)
      return false
    }
    // For sectioned loops, require finalAuditDone === true before terminating
    if (currentState.totalSections > 0 && !currentState.finalAuditDone) {
      logger.debug(`Loop: audit clear gate blocked for sectioned loop — finalAuditDone=false`)
      return false
    }
    const findings = loopService.getOutstandingFindings(currentState.loopName)
    if (findings.length > 0) {
      logger.log(`Loop: audit complete but ${findings.length} review finding(s) remain, continuing`)
      return false
    }
    const bugFindings = loopService.getOutstandingFindings(currentState.loopName, 'bug')
    if (bugFindings.length > 0) {
      logger.log(`Loop: refused completion — ${bugFindings.length} bug finding(s) still open`)
      return false
    }
    logger.log(`Loop: audit all-clear, terminating loop=${loopName} iteration=${currentState.iteration} audits=${currentState.auditCount ?? 0}`)
    if (await enterPostActionPhase(loopName, currentState)) return true
    await terminateLoop(loopName, currentState, { kind: 'completed' })
    logger.log(`Loop completed: auditor all-clear at iteration ${currentState.iteration} (audits=${currentState.auditCount ?? 0})`)
    return true
  }

  /**
   * Transition the loop into the post_action phase: creates a new session, builds the
   * post-action prompt (with skill/prompt from config), sends it, and records the phase.
   * Returns true if the loop entered post_action (caller should return without terminating).
   */
  async function enterPostActionPhase(loopName: string, currentState: LoopState): Promise<boolean> {
    if (currentState.phase === 'post_action') return false
    const cfg = resolvePostActionConfig(getConfig())
    if (!cfg.enabled) return false
    if (!currentState.worktreeDir) return false

    const ensured = await ensureWorkspaceForLoop(loopName, currentState, 'before post-action creation')
    const permission = buildLoopPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories(getConfig()) })
    const created = await createLoopSessionWithWorkspace({
      client,
      title: formatPostActionSessionTitle(loopName),
      directory: currentState.worktreeDir,
      permission,
      workspaceId: ensured.workspaceId ?? currentState.workspaceId,
      loopName,
      logPrefix: `loop ${loopName} post-action`,
      logger,
    })
    if (!created) {
      logger.error(`Loop: post-action session creation failed for ${loopName}, completing without action`)
      return false
    }

    loopService.registerLoopSession(created.sessionId, loopName)
    sessionToLoop.set(created.sessionId, loopName)

    const prompt = loopService.buildPostActionPrompt(currentState, { skill: cfg.skill, prompt: cfg.prompt })
    loopService.setPhaseAndResetError(loopName, 'post_action')
    // Retain the old session in the reverse index so delayed errors from the
    // pre-transition session still resolve to this loop after DB-level replacement.
    sessionToLoop.set(currentState.sessionId, loopName)
    loopService.replaceSession(loopName, { newSessionId: created.sessionId, phase: 'post_action' })
    void scheduleSessionDelete({ loopName, sessionId: currentState.sessionId, directory: currentState.worktreeDir, context: 'after post-action creation', phase: currentState.phase, state: currentState })

    const auditorModel = resolveLoopAuditorModel(getConfig(), loopService, loopName)
    const configuredModel = cfg.model ? parseModelString(cfg.model) : undefined
    // Use the configured post-action model if set, falling back to the loop's auditor model when it fails.
    const primaryModel = configuredModel ?? auditorModel
    const fallbackModel = configuredModel ? auditorModel : undefined
    const { error } = await sendPromptWithFallback({ loopName, sessionId: created.sessionId, promptText: prompt, agent: 'code', model: primaryModel, fallbackModel, variant: currentState.executionVariant })
    if (error) {
      const targetState = loopService.getActiveState(loopName) ?? currentState
      logger.error(`Loop: failed to send post-action prompt for ${loopName}, completing without action`, error)
      await terminateLoop(loopName, targetState, { kind: 'completed' })
      return true
    }
    watchdog.recordActivity(loopName, 'post-action-prompt-sent')
    return true
  }

  function bumpDirtyAuditRecurrence(loopName: string, bugFindings: ReviewFindingRow[], sectionIndex?: number): void {
    const findings = sectionIndex === undefined ? bugFindings : bugFindings.filter(f => f.sectionIndex === sectionIndex)
    loopService.bumpFindingRecurrence(loopName, findings)
  }

  /**
   * Shared: reset error count after a successful (non-error) iteration.
   */
  function resetErrorCountIfNeeded(loopName: string, currentState: LoopState, assistantErrorDetected: boolean, phase: string): LoopState {
    if (!assistantErrorDetected && currentState.errorCount && currentState.errorCount > 0) {
      loopService.resetError(loopName)
      loopService.setModelFailed(loopName, false)
      logger.log(`Loop: resetting error count after successful retry in ${phase} phase`)
      return loopService.getActiveState(loopName)!
    }
    return currentState
  }

  /**
   * Shared: rotate session and send continuation prompt with model fallback.
   */
  async function rotateAndSendContinuation(
    loopName: string,
    currentState: LoopState,
    stateUpdates: Partial<LoopState>,
    continuationPrompt: string,
    assistantErrorDetected: boolean,
    errorContext: string,
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

    loopService.replaceSession(loopName, {
      newSessionId: activeSessionId,
      phase: stateUpdates.phase ?? 'coding',
      iteration: stateUpdates.iteration ?? currentState.iteration,
      resetError: !assistantErrorDetected && currentState.errorCount > 0,
      auditCount: stateUpdates.auditCount,
      lastAuditResult: stateUpdates.lastAuditResult ?? null,
      ...(currentState.kind === 'goal' ? { executorSessionId: activeSessionId } : {}),
    })

    const nextIteration = stateUpdates.iteration ?? currentState.iteration
    logger.log(`Loop iteration ${nextIteration} for session ${activeSessionId}`)

    const currentConfig = getConfig()
    const loopModel = resolveLoopModel(currentConfig, loopService, loopName)
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

  async function rotateToCodingAfterAuditFailure(loopName: string, state: LoopState, reason: string): Promise<void> {
    const newSessionId = await rotateSession(loopName, state)

    loopService.replaceSession(loopName, {
      newSessionId,
      phase: 'coding',
      resetError: false,
      ...(state.kind === 'goal' ? { executorSessionId: newSessionId } : {}),
    })
    loopService.setLastAuditResult(loopName, state.lastAuditResult ?? '')
    const isModelError = /provider|auth|model|api\s*error/i.test(reason)
    if (isModelError) {
      loopService.setModelFailed(loopName, true)
    }
    const continuationPrompt = loopService.buildContinuationPrompt(
      { ...state, iteration: state.iteration ?? 0 },
      `\n[Auditor session failed: ${reason}. Continuing without new findings.]`,
    )

    const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
    const { error } = await sendPromptWithFallback({
      loopName,
      sessionId: newSessionId,
      promptText: continuationPrompt,
      agent: 'code',
      model: loopModel,
      variant: state.executionVariant,
    })
    if (error) {
      await handlePromptError(loopName, loopService.getActiveState(loopName) ?? state, 'rotateToCodingAfterAuditFailure: failed to send continuation prompt', error)
    }
  }

  function buildCodingPromptForCurrentState(state: LoopState): string {
    if (pendingFinalAuditFix.has(state.loopName)) {
      return loopService.buildFinalAuditFixPrompt(state, state.lastAuditResult || '')
    }
    if (state.totalSections > 0) {
      if (state.lastAuditResult) {
        return loopService.buildSectionContinuationPrompt(state, state.lastAuditResult)
      }
      return loopService.buildSectionInitialPrompt(state)
    }
    return loopService.buildContinuationPrompt(state, state.lastAuditResult || undefined)
  }

  async function recoverCodeLaunchWithoutAssistant(loopName: string, state: LoopState, lastMessageRole: string): Promise<void> {
    const attempts = (codingLaunchRecoveryAttempts.get(loopName) ?? 0) + 1
    codingLaunchRecoveryAttempts.set(loopName, attempts)

    if (attempts > MAX_CODE_LAUNCH_RECOVERIES) {
      logger.error(`Loop: coding launch failed after ${attempts} no-assistant idle events for ${loopName} (last=${lastMessageRole})`)
      await terminateLoop(loopName, state, { kind: 'coding_no_assistant' })
      return
    }

    const recoveryPrompt = buildCodingPromptForCurrentState(state)
    logger.log(`Loop: recovering code launch for ${loopName} (attempt ${attempts}/${MAX_CODE_LAUNCH_RECOVERIES}, last=${lastMessageRole})`)

    const codeSessionId = state.sessionId

    try {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active || freshState.phase !== 'coding' || freshState.sessionId !== codeSessionId) return

      const currentConfig = getConfig()
      await sendPromptWithRetryRecovery({
        loopName,
        sessionId: codeSessionId,
        promptText: recoveryPrompt,
        agent: 'code',
        model: resolveLoopModel(currentConfig, loopService, loopName),
        variant: freshState.executionVariant,
        errorContext: 'failed to recover code launch',
        sendErrorContext: 'failed to recover code launch',
        errorState: freshState,
        onSendError: () => clearPromptPending(loopName, logger),
        isRetryValid: (fresh) => fresh.phase === 'coding' && fresh.sessionId === codeSessionId,
        send: async (fresh) => {
          await client.session.promptAsync({
            sessionID: codeSessionId,
            directory: fresh.worktreeDir,
            ...(fresh.workspaceId ? { workspace: fresh.workspaceId } : {}),
            agent: 'code',
            parts: [{ type: 'text' as const, text: recoveryPrompt }],
          })
        },
      })
    } catch (err) {
      logger.error(`Loop: failed to recover code launch for ${loopName}`, err)
      await handlePromptError(loopName, state, 'failed to recover code launch', err)
    }
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
    const queue = loopRetainedSessions.get(loopName) ?? []
    
    // Check if already queued by sessionId
    if (queue.some(entry => entry.sessionId === sessionId)) return
    
    // Determine role and fallback model at queue time
    const role: 'code' | 'auditor' = phase && (phase === 'auditing' || phase === 'final_auditing') ? 'auditor' : 'code'
    const fallbackModel = phase && state ? getFallbackModelForSession(state, phase) : undefined
    // Stamp the loop's started_at as the run identity for the usage row
    // captured later when this session is trimmed. Falls back to 0 only when
    // no state was supplied (defensive; usage rows with run_started_at = 0 will
    // never match a real run's aggregate, so they are simply not counted).
    const runStartedAt = state ? new Date(state.startedAt).getTime() : 0
    
    queue.push({ sessionId, role, fallbackModel, directory, runStartedAt })
    loopRetainedSessions.set(loopName, queue)
    logger.debug(`Loop: queued session ${sessionId} for retention (loop=${loopName}, context=${context}, queue=${queue.length})`)

    while (queue.length > SESSION_RETENTION) {
      const oldest = queue.shift()!
      logger.log(`Loop: trimming session ${oldest.sessionId} (loop=${loopName}, retention=${SESSION_RETENTION})`)

      // Capture usage before deletion using stored metadata. Register the
      // capture promise in the per-loop pending set BEFORE awaiting so a
      // concurrent terminateLoop can await it and include this session's
      // usage in the run summary even though it has already been shifted
      // out of the retain queue.
      const capturePromise = captureLoopSessionUsage({
        loopName,
        sessionId: oldest.sessionId,
        directory: oldest.directory,
        role: oldest.role,
        fallbackModel: oldest.fallbackModel,
        runStartedAt: oldest.runStartedAt,
      })
      trackUsageCapture(loopName, capturePromise)
      await capturePromise

      void client.session.delete({ sessionID: oldest.sessionId, directory: oldest.directory }).catch((err: unknown) => {
        logger.error(`Loop: failed to delete trimmed session ${oldest.sessionId} (loop=${loopName})`, err)
      })
    }
  }

  async function terminateLoop(loopName: string, state: LoopState, reason: TerminationReason, summary?: string): Promise<void> {
    // Atomic admission guard: only one terminateLoop call per loop can proceed
    // at a time.  Concurrent callers (e.g. user cancel vs. provider-limit
    // detection vs. watchdog) see the flag and skip, preventing double execution
    // of usage capture, abort, persistence, and host teardown.
    if (terminatingLoops.has(loopName)) {
      logger.debug(`Loop: terminateLoop called for already-terminating loop ${loopName}, skipping`)
      return
    }
    terminatingLoops.add(loopName)

    try {
    // Idempotency guard: if the loop was already terminated by a concurrent
    // path (e.g. watchdog vs. runtime event), skip duplicate side effects.
    const current = loopService.getActiveState(loopName)
    if (!current?.active) {
      logger.debug(`Loop: terminateLoop called for already-terminated loop ${loopName}, skipping`)
      return
    }

    const sessionId = state.sessionId
    watchdog.stop(loopName)
    loopRegistry.remove(loopName)

    const retryTimeout = retryTimeouts.get(loopName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeouts.delete(loopName)
    }

    const idleRetryTimeout = idleRetryTimeouts.get(loopName)
    if (idleRetryTimeout) {
      clearTimeout(idleRetryTimeout)
      idleRetryTimeouts.delete(loopName)
    }
    idleRetryAttempts.delete(loopName)
    codingLaunchRecoveryAttempts.delete(loopName)
    pendingFinalAuditFix.delete(loopName)
    clearPromptPending(loopName, logger)
    clearPromptInFlight(loopName)

    const retained = loopRetainedSessions.get(loopName)
    if (retained) {
      // Capture usage for retained sessions before deletion using stored metadata
      for (const entry of retained) {
        if (entry.sessionId === sessionId) continue
        await captureLoopSessionUsage({
          loopName,
          sessionId: entry.sessionId,
          directory: entry.directory,
          role: entry.role,
          fallbackModel: entry.fallbackModel,
          runStartedAt: entry.runStartedAt,
        }).catch((err: unknown) => {
          logger.error(`Loop: failed to capture usage for retained session ${entry.sessionId} on terminate (loop=${loopName})`, err)
        })
        void client.session.delete({ sessionID: entry.sessionId, directory: entry.directory }).catch((err: unknown) => {
          logger.error(`Loop: failed to delete retained session ${entry.sessionId} on terminate (loop=${loopName})`, err)
        })
      }
      loopRetainedSessions.delete(loopName)
    }

    // Clean up session→loop reverse index for this loop
    for (const [sid, ln] of sessionToLoop) {
      if (ln === loopName) sessionToLoop.delete(sid)
    }
    sessionToLoop.delete(sessionId)

    // Capture usage for the final active session before termination
    const fallbackModel = getFallbackModelForSession(state, state.phase)
    const role: 'code' | 'auditor' = state.phase === 'auditing' || state.phase === 'final_auditing' ? 'auditor' : 'code'
    await captureLoopSessionUsage({
      loopName,
      sessionId: state.sessionId,
      directory: state.worktreeDir,
      role,
      fallbackModel,
      runStartedAt: new Date(state.startedAt).getTime(),
    })

    // Wait for any usage captures still in flight from scheduleSessionDelete
    // trims that have already shifted their session out of the retain queue.
    // Without this, recordTermination could compute the run aggregate before
    // the trimmed session's usage row lands, permanently undercounting the run.
    await awaitPendingUsageCaptures(loopName)

    const now = Date.now()
    loopService.terminate(loopName, {
      status: terminationStatusFor(reason),
      reason: terminationReasonToString(reason),
      completedAt: now,
      summary,
    })

    // Record termination after usage capture + loopService.terminate so the run row
    // reflects the final usage aggregate and the canonical status/reason. Non-fatal.
    metrics.recordTermination(state, {
      status: terminationStatusFor(reason),
      reason: terminationReasonToString(reason),
      completedAt: now,
    })

    try {
      await client.session.abort({ sessionID: sessionId })
    } catch {
      // Session may already be idle
    }

    logger.log(`Loop terminated: reason="${terminationReasonToString(reason)}", loop="${state.loopName}", iteration=${state.iteration}`)

    logger.debug(`Loop: terminateLoop reason=${terminationReasonToString(reason)} worktree=${!!state.worktree} logEligible=${reason.kind === 'completed' && !!state.worktree}`)

    // Delegate host-specific side-effects to the provided callback.
    // This keeps worktree teardown, completion log, sandbox stop, TUI toast outside the core module.
    if (onTerminated) {
      await onTerminated(state, reason)
    }
    } finally {
      terminatingLoops.delete(loopName)
    }
  }

  /**
   * Mirror terminateLoop's usage-capture + recordTermination step for an active
   * loop that is about to be restarted. The restart caller replaces the loop
   * row directly (loopsRepo.restart) so this method deliberately skips
   * loopService.terminate, onTerminated teardown, watchdog stop, and timer
   * cleanup — the restart command already cleared timers and will swap the
   * session/started_at. Only the metrics side-effects (loop_terminated event
   * + loop_runs summary row) and any in-flight usage capture are performed so
   * the previous run is not silently lost from loop_metrics. Non-fatal.
   */
  async function finalizeRunForRestart(loopName: string, reason: TerminationReason): Promise<void> {
    const state = loopService.getActiveState(loopName)
    if (!state?.active) {
      return
    }

    try {
      // Capture usage for retained sessions queued by scheduleSessionDelete. These
      // belong to the outgoing run; without capture here they would never land
      // in the run-scoped aggregate (their run identity was stamped at queue
      // time, so capture uses the stored entry rather than fresh state).
      const retained = loopRetainedSessions.get(loopName)
      if (retained) {
        for (const entry of retained) {
          if (entry.sessionId === state.sessionId) continue
          await captureLoopSessionUsage({
            loopName,
            sessionId: entry.sessionId,
            directory: entry.directory,
            role: entry.role,
            fallbackModel: entry.fallbackModel,
            runStartedAt: entry.runStartedAt,
          }).catch((err: unknown) => {
            logger.error(`Loop: failed to capture usage for retained session ${entry.sessionId} on restart (loop=${loopName})`, err)
          })
        }
        loopRetainedSessions.delete(loopName)
      }

      // Drop reverse-index entries for the outgoing run's sessions. The restart
      // caller registers the new session afterward; leaving stale entries would
      // let delayed errors from the old sessions terminate the replacement run.
      for (const [sid, ln] of sessionToLoop) {
        if (ln === loopName) sessionToLoop.delete(sid)
      }

      // Capture usage for the active session before loopsRepo.restart resets
      // started_at (so the row stamps the outgoing run identity).
      const fallbackModel = getFallbackModelForSession(state, state.phase)
      const role: 'code' | 'auditor' = state.phase === 'auditing' || state.phase === 'final_auditing' ? 'auditor' : 'code'
      await captureLoopSessionUsage({
        loopName,
        sessionId: state.sessionId,
        directory: state.worktreeDir,
        role,
        fallbackModel,
        runStartedAt: new Date(state.startedAt).getTime(),
      })

      // Ensure any in-flight capture from a concurrent scheduleSessionDelete
      // trim lands before the run summary is computed.
      await awaitPendingUsageCaptures(loopName)

      const now = Date.now()
      metrics.recordTermination(state, {
        status: terminationStatusFor(reason),
        reason: terminationReasonToString(reason),
        completedAt: now,
      })
    } catch (err) {
      logger.debug(`Loop: failed to finalize outgoing run metrics for restart of loop ${loopName}`, err)
    }
  }

  async function handlePromptError(loopName: string, _state: LoopState, context: string, err: unknown, retryFn?: () => Promise<void>): Promise<void> {
    if (err instanceof ConcurrentPromptError) {
      logger.log(`Loop: ${context} — rejected as concurrent prompt (prior guard active), skipping retry/termination`)
      return
    }

    const currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} already terminated, ignoring error: ${context}`)
      return
    }

    const signal = extractErrorSignal(err)
    const limitReason = classifyProviderLimit(signal)
    if (limitReason) {
      logger.error(`Loop: ${context} — provider limit detected, terminating without retry`)
      await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
      return
    }

    const nextErrorCount = (currentState.errorCount ?? 0) + 1
    
    if (nextErrorCount < MAX_RETRIES) {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), will retry`, err)
      loopService.incrementError(loopName)
      if (retryFn) {
        const retryTimeout = setTimeout(async () => {
          const freshState = loopService.getActiveState(loopName)
          if (!freshState?.active) {
            logger.log(`Loop: loop cancelled, skipping retry`)
            retryTimeouts.delete(loopName)
            return
          }
          try {
            await retryFn()
          } catch (retryErr) {
            await handlePromptError(loopName, freshState, context, retryErr, retryFn)
          }
        }, 2000)
        retryTimeouts.set(loopName, retryTimeout)
      }
    } else {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), giving up`, err)
      await terminateLoop(loopName, currentState, { kind: 'error_max_retries', message: context })
    }
  }

  interface PromptRetryOptions {
    loopName: string
    sessionId: string
    agent: 'code' | 'auditor-loop'
    /** Base label used in retry logs; inner retry errors report `retry failed ${errorContext}`. */
    errorContext: string
    /** Extra freshness predicate beyond `freshState.active`; retry aborts (throws loop_cancelled) when it returns false. */
    isRetryValid?: (fresh: LoopState) => boolean
    /** Custom retry send action. When omitted, the default `client.session.promptAsync` send with inner handlePromptError catch is used (requires promptText). */
    send?: (fresh: LoopState) => Promise<void>
    promptText?: string
  }

  function buildPromptRetryFn(opts: PromptRetryOptions): () => Promise<void> {
    const defaultSend = async (freshState: LoopState): Promise<void> => {
      try {
        await client.session.promptAsync({
          sessionID: opts.sessionId,
          directory: freshState.worktreeDir,
          ...(freshState.workspaceId ? { workspace: freshState.workspaceId } : {}),
          agent: opts.agent,
          parts: [{ type: 'text' as const, text: opts.promptText ?? '' }],
        })
      } catch (err) {
        await handlePromptError(opts.loopName, freshState, `retry failed ${opts.errorContext}`, err)
      }
    }
    const send = opts.send ?? defaultSend
    return async () => {
      const freshState = loopService.getActiveState(opts.loopName)
      if (!freshState?.active || (opts.isRetryValid && !opts.isRetryValid(freshState))) throw new Error('loop_cancelled')
      try {
        await withInFlightGuard(opts.loopName, opts.sessionId, opts.agent, logger, () => send(freshState))
      } catch (err) {
        if (err instanceof ConcurrentPromptError) {
          logger.log(`Loop: ${opts.errorContext} — retry rejected as concurrent prompt (prior guard active), skipping`)
          return
        }
        throw err
      }
    }
  }

  interface SendPromptWithRetryRecoveryOptions extends PromptRetryOptions {
    promptText: string
    model?: Parameters<typeof sendPromptWithFallback>[0]['model']
    variant?: string
    /** State passed to handlePromptError when the initial send fails. */
    errorState: LoopState
    /** Context for the initial-send failure; defaults to `failed to send ${errorContext}`. */
    sendErrorContext?: string
    /** Watchdog activity tag recorded on successful send. Omit to skip. */
    activityTag?: string
    /** Invoked once when the initial send fails, before retry recovery (e.g. clearPromptPending). */
    onSendError?: () => void
  }

  async function sendPromptWithRetryRecovery(
    opts: SendPromptWithRetryRecoveryOptions,
  ): Promise<{ sent: boolean; usedModel?: Awaited<ReturnType<typeof sendPromptWithFallback>>['usedModel'] }> {
    const { error, usedModel } = await sendPromptWithFallback({
      loopName: opts.loopName,
      sessionId: opts.sessionId,
      promptText: opts.promptText,
      agent: opts.agent,
      model: opts.model,
      variant: opts.variant,
    })
    if (error) {
      opts.onSendError?.()
      const context = opts.sendErrorContext ?? `failed to send ${opts.errorContext}`
      logger.error(`Loop: ${context} for ${opts.loopName}`, error)
      await handlePromptError(opts.loopName, opts.errorState, context, error, buildPromptRetryFn(opts))
      return { sent: false }
    }
    if (opts.activityTag) watchdog.recordActivity(opts.loopName, opts.activityTag)
    return { sent: true, usedModel }
  }

  async function recoverWatchdogStall(
    loopName: string,
    _state: LoopState,
    context: LoopWatchdogRecoveryContext,
  ): Promise<void> {
    await withStateLock(loopName, async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) return

      try {
        if (freshState.phase === 'auditing') {
          await runAuditingPhase(loopName, freshState)
        } else if (freshState.phase === 'final_auditing') {
          await runFinalAuditPhase(loopName, freshState)
        } else if (freshState.phase === 'post_action') {
          await runPostActionPhase(loopName, freshState)
        } else {
          await runCodingPhase(loopName, freshState)
        }
      } catch (err) {
        await handlePromptError(loopName, freshState, `watchdog recovery in ${freshState.phase} phase (${context.reason})`, err)
      }
    })
  }

  /**
   * Atomically check active state and terminate inside the state lock.
   * Prevents duplicate side-effects when the watchdog and runtime detect the
   * same provider limit concurrently — the second caller sees the loop
   * already terminated and skips.
   */
  async function tryTerminateLoop(loopName: string, _state: LoopState, reason: TerminationReason): Promise<void> {
    await withStateLock(loopName, async () => {
      const fresh = loopService.getActiveState(loopName)
      if (!fresh?.active) return
      await terminateLoop(loopName, fresh, reason)
    })
  }

  const watchdog = createLoopWatchdog({
    loopService,
    client,
    logger,
    recover: recoverWatchdogStall,
    terminate: tryTerminateLoop,
    resolveSessionLoopName,
  })

  /**
   * Shared idle/no-assistant gate for the auditing, final_auditing, and post_action phases.
   * If the last message is not from the assistant, schedules a bounded retry (re-invoking `rerun`)
   * or terminates with `exhaustedReason` once MAX_IDLE_RETRIES is reached. When an assistant message
   * is present it clears any pending idle-retry timer/attempts. Returns true when the caller should
   * return early (retry scheduled or loop terminated).
   */
  async function handleIdleNoAssistantGate(
    loopName: string,
    currentState: LoopState,
    lastMessageRole: string,
    opts: { phaseLabel: string; exhaustedReason: TerminationReason; rerun: (loopName: string, state: LoopState) => Promise<void> },
  ): Promise<boolean> {
    if (lastMessageRole !== 'assistant') {
      const attempts = idleRetryAttempts.get(loopName) ?? 0
      if (attempts >= MAX_IDLE_RETRIES) {
        logger.error(`Loop: ${opts.phaseLabel} retry exhausted for ${loopName} (last message: ${lastMessageRole}), terminating`)
        idleRetryAttempts.delete(loopName)
        await terminateLoop(loopName, currentState, opts.exhaustedReason)
        return true
      }
      logger.log(`Loop: ${opts.phaseLabel} idle without assistant message (last=${lastMessageRole}), retrying in ${IDLE_RETRY_DELAY_MS}ms (attempt ${attempts + 1}/${MAX_IDLE_RETRIES})`)
      idleRetryAttempts.set(loopName, attempts + 1)
      const phase = currentState.phase
      const t = setTimeout(() => {
        void withStateLock(loopName, async () => {
          const fresh = loopService.getActiveState(loopName)
          if (!fresh?.active || fresh.phase !== phase) return
          await opts.rerun(loopName, fresh)
        })
      }, IDLE_RETRY_DELAY_MS)
      idleRetryTimeouts.set(loopName, t)
      return true
    }
    const pending = idleRetryTimeouts.get(loopName)
    if (pending) { clearTimeout(pending); idleRetryTimeouts.delete(loopName) }
    if (idleRetryAttempts.has(loopName)) { idleRetryAttempts.delete(loopName) }
    return false
  }

  async function startFinalAuditTransition(loopName: string, currentState: LoopState): Promise<boolean> {
    const finalAuditState = loopService.getActiveState(loopName) ?? { ...currentState, phase: 'final_auditing' }
    const finalAuditPrompt = loopService.buildFinalAuditPrompt(finalAuditState)
    const auditorModel = resolveLoopAuditorModel(getConfig(), loopService, loopName, logger)

    const ensured = await ensureWorkspaceForLoop(loopName, currentState, 'before final audit creation')
    const created = await createAuditSession({
      client,
      loopName,
      iteration: currentState.iteration ?? 0,
      currentSectionIndex: currentState.currentSectionIndex ?? 0,
      totalSections: currentState.totalSections ?? 0,
      worktreeDir: currentState.worktreeDir,
      workspaceId: ensured.workspaceId ?? currentState.workspaceId,
      auditorModel,
      prompt: finalAuditPrompt,
      allowDirectories: resolveLoopAllowedDirectories(getConfig()),
      logger,
    })
    if (!created) {
      logger.error(`Loop: final audit session creation failed for ${loopName}`)
      await handlePromptError(loopName, finalAuditState, 'failed to create final audit session', new Error('audit session creation failed'))
      return false
    }

    loopService.setPhaseAndResetError(loopName, 'final_auditing')

    // Retain the old session in the reverse index so delayed errors from the
    // pre-transition session still resolve to this loop after DB-level replacement.
    sessionToLoop.set(currentState.sessionId, loopName)
    loopService.replaceSession(loopName, {
      newSessionId: created.auditSessionId,
      phase: 'final_auditing',
    })
    sessionToLoop.set(created.auditSessionId, loopName)

    // Retire the pre-transition session. Derive the role/fallback attribution
    // from currentState.phase rather than hardcoding 'coding': when this
    // transition is reached from a section audit (runAuditingPhase), the
    // retired session is an auditor session and must be captured with
    // role='auditor' + auditor fallback model — misattributing it as coding
    // would store auditor usage under the execution model.
    void scheduleSessionDelete({ loopName, sessionId: currentState.sessionId, directory: currentState.worktreeDir, context: 'after final audit creation', phase: currentState.phase, state: currentState })

    const { error: finalAuditPromptErr } = await sendPromptWithFallback({
      loopName,
      sessionId: created.auditSessionId,
      promptText: finalAuditPrompt,
      agent: 'auditor-loop',
      model: auditorModel,
      variant: currentState.auditorVariant,
    })

    if (finalAuditPromptErr) {
      logger.error(`Loop: failed to send final audit prompt for ${loopName}`, finalAuditPromptErr)
      await handlePromptError(loopName, finalAuditState, 'failed to send final audit prompt', finalAuditPromptErr)
      return false
    }
    watchdog.recordActivity(loopName, 'final-audit-prompt-sent')
    return true
  }

  async function runCodingPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping coding phase`)
      return
    }

    if (currentState.phase !== 'coding') {
      logger.log(`Loop: runCodingPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in coding phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const assistantInfo = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)
    const assistantError = assistantInfo.error
    const lastMessageRole = assistantInfo.lastMessageRole

    // Classify persisted provider-limit errors before the no-assistant gate.
    // A finish:'error' assistant message has lastMessageRole 'assistant:error'
    // which the gate treats as missing, but a provider limit must terminate
    // immediately rather than entering the idle-retry path.
    if (assistantInfo.errorSignal) {
      const limitReason = classifyProviderLimit(assistantInfo.errorSignal)
      if (limitReason) {
        logger.error(`Loop: provider limit in persisted coding error for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
        return
      }
    }

    if (lastMessageRole !== 'assistant') {
      const attempts = idleRetryAttempts.get(loopName) ?? 0
      if (attempts < MAX_IDLE_RETRIES) {
        logger.log(`Loop: coding idle without assistant message (last=${lastMessageRole}), retrying in ${IDLE_RETRY_DELAY_MS}ms (attempt ${attempts + 1}/${MAX_IDLE_RETRIES})`)
        idleRetryAttempts.set(loopName, attempts + 1)
        const sessionId = currentState.sessionId
        const t = setTimeout(async () => {
          idleRetryTimeouts.delete(loopName)
          await withStateLock(loopName, async () => {
            const retryState = loopService.getActiveState(loopName)
            if (!retryState?.active || retryState.phase !== 'coding' || retryState.sessionId !== sessionId) return
            await runCodingPhase(loopName, retryState)
          })
        }, IDLE_RETRY_DELAY_MS)
        idleRetryTimeouts.set(loopName, t)
        return
      }

      logger.log(`Loop: coding phase has no assistant response for ${loopName} after retry (last message: ${lastMessageRole}); recovering code launch`)
      idleRetryAttempts.delete(loopName)
      await recoverCodeLaunchWithoutAssistant(loopName, currentState, lastMessageRole)
      return
    }

    const pending = idleRetryTimeouts.get(loopName)
    if (pending) {
      clearTimeout(pending)
      idleRetryTimeouts.delete(loopName)
    }
    if (idleRetryAttempts.has(loopName)) {
      idleRetryAttempts.delete(loopName)
    }
    codingLaunchRecoveryAttempts.delete(loopName)

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'coding', assistantInfo.errorSignal)
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'coding')

    // Parse coder decisions from the coding assistant's response and store for the audit prompt.
    // This must happen before the pendingFinalAuditFix early return so that decisions emitted
    // during a final-audit fix coding session reach the subsequent final audit prompt.
    loopService.setCoderDecisions(loopName, parseCoderDecisions(assistantInfo.text))

    // If this coding pass was a final-audit fix, skip the per-section audit and
    // transition straight back to final_auditing.
    if (pendingFinalAuditFix.has(loopName)) {
      pendingFinalAuditFix.delete(loopName)
      logger.log(`Loop: final-audit fix coding complete for ${loopName}, transitioning back to final_auditing`)
      await metrics.recordPhaseEvent({
        state: currentState,
        eventType: 'coding_done',
        outcome: 'final_audit_fix_done',
        sessionId: currentState.sessionId,
        directory: currentState.worktreeDir,
        role: 'code',
        fallbackModel: getFallbackModelForSession(currentState, 'coding'),
      })
      const started = await startFinalAuditTransition(loopName, currentState)
      if (!started) {
        logger.error(`Loop: failed to restart final audit after fix for ${loopName}`)
      }
      return
    }

    const currentConfig = getConfig()
    const auditorModel = resolveLoopAuditorModel(currentConfig, loopService, loopName, logger)
    const auditPrompt = loopService.buildAuditPrompt(currentState)
    const codeSessionId = currentState.sessionId

    async function createAuditWithRetry(input: {
      loopName: string
      iteration: number
      currentSectionIndex: number
      totalSections: number
      worktreeDir: string
      workspaceId?: string
      auditorModel?: { providerID: string; modelID: string }
      prompt: string
      allowDirectories?: string[]
    }, attempts = MAX_RETRIES): Promise<{ auditSessionId: string; boundWorkspaceId?: string; bindFailed: boolean; bindError?: unknown } | null> {
      for (let i = 0; i < attempts; i++) {
        const created = await createAuditSession({ client, ...input, logger })
        if (created) return created
        loopService.incrementError(loopName)
        const state = loopService.getActiveState(loopName)
        if (!state?.active) return null
        if ((state.errorCount ?? 0) >= MAX_RETRIES) return null
        await new Promise((r) => setTimeout(r, 500 * (i + 1)))
      }
      return null
    }

    const ensured = await ensureWorkspaceForLoop(loopName, currentState, 'before audit creation')
    const created = await createAuditWithRetry({
      loopName,
      iteration: currentState.iteration ?? 0,
      currentSectionIndex: currentState.currentSectionIndex ?? 0,
      totalSections: currentState.totalSections ?? 0,
      worktreeDir: currentState.worktreeDir,
      workspaceId: ensured.workspaceId ?? currentState.workspaceId,
      auditorModel,
      prompt: auditPrompt,
      allowDirectories: resolveLoopAllowedDirectories(currentConfig),
    })

    if (!created) {
      logger.error(`Loop: audit session creation failed after ${MAX_RETRIES} attempts for ${loopName}, rotating to fresh code session`)
      loopService.resetError(loopName)
      try {
        const rotatedSessionId = await rotateSession(loopName, currentState)
        loopService.replaceSession(loopName, {
          newSessionId: rotatedSessionId,
          phase: 'coding',
          resetError: false,
          ...(currentState.kind === 'goal' ? { executorSessionId: rotatedSessionId } : {}),
        })
        const continuationPrompt = loopService.buildContinuationPrompt(
          { ...currentState, iteration: currentState.iteration ?? 0 },
          'Audit could not be started after retries — continue iterating, the auditor will be reattempted next round.',
        )
        const { error: promptErr } = await sendPromptWithFallback({
          loopName,
          sessionId: rotatedSessionId,
          promptText: continuationPrompt,
          agent: 'code',
          variant: currentState.executionVariant,
        })
        if (promptErr) {
          await handlePromptError(loopName, loopService.getActiveState(loopName) ?? currentState, 'failed to send continuation prompt after audit creation failure', promptErr)
        }
        return
      } catch (err) {
        logger.error(`Loop: failed to rotate after audit creation failure`, err)
        await handlePromptError(loopName, currentState, 'failed to rotate after audit creation failure', err)
        return
      }
    }

    if (created.bindFailed && currentState.workspaceId) {
      const recovered = await recoverFromMissingWorkspace(loopName, currentState, created.auditSessionId, 'during audit bind', created.bindError)
      currentState = loopService.getActiveState(loopName) ?? currentState
      if (!recovered.recovered) {
        logger.log(`Loop: workspace re-provision failed for ${loopName}, continuing without workspace backing`)
      }
    }

    // Retain the old session in the reverse index so delayed errors from the
    // pre-transition session still resolve to this loop after DB-level replacement.
    sessionToLoop.set(codeSessionId, loopName)
    await metrics.recordPhaseEvent({
      state: currentState,
      eventType: 'coding_done',
      outcome: 'audit_started',
      sessionId: codeSessionId,
      directory: currentState.worktreeDir,
      role: 'code',
      fallbackModel: getFallbackModelForSession(currentState, 'coding'),
    })
    loopService.replaceSession(loopName, {
      newSessionId: created.auditSessionId,
      phase: 'auditing',
    })
    sessionToLoop.set(created.auditSessionId, loopName)

    // The retired session is a code session.
    void scheduleSessionDelete({ loopName, sessionId: codeSessionId, directory: currentState.worktreeDir, context: 'after audit creation', phase: 'coding', state: currentState })

    const { error: auditPromptErr, usedModel: actualAuditorModel } = await sendPromptWithFallback({
      loopName,
      sessionId: created.auditSessionId,
      promptText: loopService.buildAuditPrompt(currentState),
      agent: 'auditor-loop',
      model: auditorModel,
      variant: currentState.auditorVariant,
    })

    if (auditPromptErr) {
      let effectiveErr: unknown = auditPromptErr
      if (isWorkspaceNotFoundError(auditPromptErr) && currentState.workspaceId) {
        const recovered = await recoverFromMissingWorkspace(loopName, currentState, created.auditSessionId, 'during audit prompt recovery')
        currentState = loopService.getActiveState(loopName) ?? currentState
        if (recovered.recovered || !currentState.workspaceId) {
          const auditPromptText = loopService.buildAuditPrompt(currentState)
          const retryResult = await promptAuditSession(client, {
            sessionId: created.auditSessionId,
            worktreeDir: currentState.worktreeDir,
            workspaceId: currentState.workspaceId,
            prompt: auditPromptText,
            auditorModel,
            auditorVariant: currentState.auditorVariant,
          })
          if (retryResult.ok) {
            logger.log(`Loop: recovered audit prompt after workspace re-bind for ${loopName}`)
            watchdog.recordActivity(loopName, 'audit-recover')
            return
          }
          // Resend failed — use the actual resend error for classification and retry
          effectiveErr = retryResult.error
        }
      }
      const retryFn = buildPromptRetryFn({
        loopName,
        sessionId: created.auditSessionId,
        agent: 'auditor-loop',
        errorContext: 'failed to send audit prompt',
        send: async (fresh) => {
          const retryResult = await promptAuditSession(client, {
            sessionId: created.auditSessionId,
            worktreeDir: fresh.worktreeDir,
            workspaceId: fresh.workspaceId,
            prompt: loopService.buildAuditPrompt(fresh),
            auditorModel,
            auditorVariant: fresh.auditorVariant,
          })
          if (!retryResult.ok) throw retryResult.error
        },
      })
      await handlePromptError(loopName, { ...currentState, phase: 'auditing' }, 'failed to send audit prompt', effectiveErr, retryFn)
      return
    }
    if (actualAuditorModel) {
      logger.log(`auditor using model: ${actualAuditorModel.providerID}/${actualAuditorModel.modelID} (session ${created.auditSessionId})`)
    } else {
      logger.log(`auditor using default model (fallback) (session ${created.auditSessionId})`)
    }

    watchdog.recordActivity(loopName, 'audit-created')
  }

  /**
   * Goal-loop audit result handler. Goal loops have no sections, final audit,
   * or post-action phase: a completed auditor pass with zero outstanding review
   * findings (any severity) terminates the loop; otherwise the auditor's
   * findings trigger a fresh code session rotation for remediation.
   * The new code session becomes both state.sessionId and state.executorSessionId.
   */
  async function runGoalAuditResult(
    loopName: string,
    currentState: LoopState,
    auditText: string,
    newAuditCount: number,
  ): Promise<void> {
    const auditSessionId = currentState.sessionId

    const persistAuditAndTerminate = async (reason: TerminationReason): Promise<void> => {
      loopService.replaceSession(loopName, {
        newSessionId: auditSessionId,
        phase: 'auditing',
        auditCount: newAuditCount,
        lastAuditResult: auditText || null,
      })
      await terminateLoop(loopName, loopService.getActiveState(loopName) ?? currentState, reason)
    }

    const outstandingFindings = loopService.getOutstandingFindings(loopName)
    const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')

    const recordGoalAuditDone = (verdict: 'clean' | 'dirty', outcome: string): Promise<void> =>
      metrics.recordPhaseEvent({
        state: { ...currentState, auditCount: newAuditCount },
        eventType: 'audit_done',
        outcome,
        verdict,
        sessionId: auditSessionId,
        directory: currentState.worktreeDir,
        role: 'auditor',
        findingsTotal: outstandingFindings.length,
        findingsBugs: outstandingBugs.length,
        fallbackModel: getFallbackModelForSession(currentState, 'auditing'),
      })

    if (outstandingFindings.length === 0) {
      logger.log(`Loop: goal audit all-clear, terminating loop=${loopName} audits=${newAuditCount}`)
      await recordGoalAuditDone('clean', 'terminate')
      await persistAuditAndTerminate({ kind: 'completed' })
      return
    }

    const nextIteration = (currentState.iteration ?? 0) + 1
    if ((currentState.maxIterations ?? 0) > 0 && nextIteration > currentState.maxIterations) {
      logger.log(`Loop: goal max iterations reached (${nextIteration}/${currentState.maxIterations}), terminating`)
      await recordGoalAuditDone('dirty', 'max_iterations')
      await persistAuditAndTerminate({ kind: 'max_iterations' })
      return
    }

    bumpDirtyAuditRecurrence(loopName, outstandingBugs)

    // Emit the dirty-continue audit event before rotating the session so messages
    // for the auditor session are still fetchable for token attribution.
    await recordGoalAuditDone('dirty', 'continue')

    // Create a fresh code session and re-bind both sessionId and executorSessionId to it.
    let newSessionId: string
    try {
      newSessionId = await rotateSession(loopName, currentState, {
        iteration: nextIteration,
      })
    } catch (err) {
      logger.error(`Loop: session rotation failed during goal dirty audit, continuing with existing session`, err)
      newSessionId = currentState.sessionId
    }

    loopService.replaceSession(loopName, {
      newSessionId,
      phase: 'coding',
      iteration: nextIteration,
      auditCount: newAuditCount,
      lastAuditResult: auditText || null,
      executorSessionId: newSessionId,
    })

    const updatedState = loopService.getActiveState(loopName) ?? { ...currentState, sessionId: newSessionId, iteration: nextIteration }
    const continuationPrompt = loopService.buildContinuationPrompt(updatedState, auditText || undefined, outstandingBugs)

    const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
    await sendPromptWithRetryRecovery({
      loopName,
      sessionId: newSessionId,
      promptText: continuationPrompt,
      agent: 'code',
      model: loopModel,
      variant: currentState.executionVariant,
      errorContext: 'goal continuation prompt',
      errorState: updatedState,
      activityTag: 'goal-continuation-prompt-sent',
    })
  }

  async function runAuditingPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping auditing phase`)
      return
    }

    if (currentState.phase !== 'auditing') {
      logger.log(`Loop: runAuditingPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in auditing phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const auditSessionId = currentState.sessionId

    const { text: auditText, error: assistantError, errorSignal: auditErrorSignal, lastMessageRole } = await getLastAssistantInfo(auditSessionId, currentState.worktreeDir)

    // Classify persisted provider-limit errors before the no-assistant gate
    // so that finish:'error' assistant messages terminate immediately.
    if (auditErrorSignal) {
      const limitReason = classifyProviderLimit(auditErrorSignal)
      if (limitReason) {
        logger.error(`Loop: provider limit in persisted auditing error for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
        return
      }
    }

    if (await handleIdleNoAssistantGate(loopName, currentState, lastMessageRole, { phaseLabel: 'auditing phase', exhaustedReason: { kind: 'audit_retry_exhausted' }, rerun: runAuditingPhase })) return

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'auditing', auditErrorSignal)
    if (!errorResult) {
      return
    }
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'auditing')

    if (!assistantErrorDetected) {
      const newAuditCount = (currentState.auditCount ?? 0) + 1
      logger.log(`Loop audit ${newAuditCount} at iteration ${currentState.iteration ?? 0}`)

      if (currentState.kind === 'goal') {
        await runGoalAuditResult(loopName, currentState, auditText || '', newAuditCount)
        return
      }

      if (currentState.totalSections > 0) {
        const idx = currentState.currentSectionIndex
        const sectionSummary = loopService.parseSectionSummary(auditText || '')
        // Section-scoped findings: bugs drive the clean/dirty verdict, while
        // findingsTotal must reflect ALL severities (bug + warning) in this
        // section so loop_events totals aren't confounded by other sections.
        const sectionAllFindings = loopService.getOutstandingFindings(loopName).filter(f => f.sectionIndex === idx)
        const sectionBugFindings = sectionAllFindings.filter(f => f.severity === 'bug')
        // All-section bug findings feed the continuation prompt and recurrence bump
        // (which re-filters by idx internally); kept separate from the metrics counts.
        const sectionAllBugFindings = loopService.getOutstandingFindings(loopName, 'bug')
        const auditedState = { ...currentState, auditCount: newAuditCount }

        if (sectionSummary && sectionBugFindings.length === 0) {
          logger.log(`Loop: section ${idx} audit clean, marking completed`)

          // Reset recurrence for this section so resolved findings don't falsely escalate later
          loopService.resetSectionRecurrence(loopName, idx)

          loopService.setLastAuditResult(loopName, auditText || '')
          loopService.completeSection(loopName, idx, sectionSummary)

          // Emit exactly one audit_done event for this clean section audit. When
          // the iteration cap is hit while advancing, fold the terminal outcome
          // into the same event so loop_runs.cleanAudits does not double-count
          // (a separate max_iterations event would inflate the clean audit tally).
          const recordCleanSectionAudit = (outcome: 'section_clean' | 'max_iterations'): Promise<void> =>
            metrics.recordPhaseEvent({
              state: auditedState,
              eventType: 'audit_done',
              outcome,
              verdict: 'clean',
              sessionId: auditSessionId,
              directory: currentState.worktreeDir,
              role: 'auditor',
              findingsTotal: sectionAllFindings.length,
              findingsBugs: sectionBugFindings.length,
              fallbackModel: getFallbackModelForSession(currentState, 'auditing'),
            })

          if (idx < currentState.totalSections - 1) {
            const allCompleted = loopService.getCompletedSectionDigest(currentState).length === currentState.totalSections
            if (allCompleted) {
              await recordCleanSectionAudit('section_clean')
              loopService.replaceSession(loopName, {
                newSessionId: currentState.sessionId,
                phase: currentState.phase,
                auditCount: newAuditCount,
              })
              logger.log(`Loop: all ${currentState.totalSections} sections completed after rewind, jumping straight to final audit`)
              await startFinalAuditTransition(loopName, auditedState)
              return
            }
          }

          const nextIdx = idx + 1
          if (nextIdx < currentState.totalSections) {
            const nextIter = (currentState.iteration ?? 0) + 1
            const maxIterationsExceeded = (currentState.maxIterations ?? 0) > 0 && nextIter > currentState.maxIterations
            await recordCleanSectionAudit(maxIterationsExceeded ? 'max_iterations' : 'section_clean')
            if (maxIterationsExceeded) {
              logger.log(`Loop: max iterations reached (${nextIter}/${currentState.maxIterations}), terminating`)
              loopService.replaceSession(loopName, {
                newSessionId: currentState.sessionId,
                phase: currentState.phase,
                auditCount: newAuditCount,
              })
              await terminateLoop(loopName, auditedState, { kind: 'max_iterations' })
              return
            }
            logger.log(`Loop: advancing from section ${idx} to section ${nextIdx}`)
            loopService.setCurrentSectionIndex(loopName, nextIdx)
            loopService.startSection(loopName, nextIdx)

            loopService.replaceSession(loopName, {
              newSessionId: currentState.sessionId,
              phase: 'coding',
              iteration: nextIter,
            })

            const updatedState = loopService.getActiveState(loopName) ?? { ...currentState, currentSectionIndex: nextIdx }
            const continuationPrompt = loopService.buildSectionInitialPrompt(updatedState)
            await rotateAndSendContinuation(
              loopName,
              currentState,
              {
                iteration: nextIter,
                currentSectionIndex: nextIdx,
                phase: 'coding',
                lastAuditResult: auditText || undefined,
                auditCount: newAuditCount,
              },
              continuationPrompt,
              assistantErrorDetected,
              'section coding continuation',
            )
            return
          } else {
            await recordCleanSectionAudit('section_clean')
            loopService.replaceSession(loopName, {
              newSessionId: currentState.sessionId,
              phase: currentState.phase,
              auditCount: newAuditCount,
            })
            logger.log(`Loop: all ${currentState.totalSections} sections completed, transitioning to final-audit`)
            await startFinalAuditTransition(loopName, auditedState)
            return
          }
        }

        logger.log(`Loop: section ${idx} audit dirty, retrying same section`)

        const nextIter = (currentState.iteration ?? 0) + 1
        if ((currentState.maxIterations ?? 0) > 0 && nextIter > currentState.maxIterations) {
          logger.log(`Loop: max iterations reached (${nextIter}/${currentState.maxIterations}), terminating`)
          await metrics.recordPhaseEvent({
            state: auditedState,
            eventType: 'audit_done',
            outcome: 'max_iterations',
            verdict: 'dirty',
            sessionId: auditSessionId,
            directory: currentState.worktreeDir,
            role: 'auditor',
            findingsTotal: sectionAllFindings.length,
            findingsBugs: sectionBugFindings.length,
            fallbackModel: getFallbackModelForSession(currentState, 'auditing'),
          })
          loopService.replaceSession(loopName, {
            newSessionId: currentState.sessionId,
            phase: currentState.phase,
            auditCount: newAuditCount,
          })
          await terminateLoop(loopName, auditedState, { kind: 'max_iterations' })
          return
        }

        loopService.incrementSectionAttempts(loopName, idx)

        await metrics.recordPhaseEvent({
          state: currentState,
          eventType: 'audit_done',
          outcome: 'section_retry',
          verdict: 'dirty',
          sessionId: auditSessionId,
          directory: currentState.worktreeDir,
          role: 'auditor',
          findingsTotal: sectionAllFindings.length,
          findingsBugs: sectionBugFindings.length,
          fallbackModel: getFallbackModelForSession(currentState, 'auditing'),
        })

        bumpDirtyAuditRecurrence(loopName, sectionAllBugFindings, idx)

        loopService.setLastAuditResult(loopName, auditText || '')
        loopService.replaceSession(loopName, {
          newSessionId: currentState.sessionId,
          phase: 'coding',
          iteration: nextIter,
        })

        const continuationPrompt = loopService.buildSectionContinuationPrompt(currentState, auditText || '', sectionAllBugFindings)
        await rotateAndSendContinuation(
          loopName,
          currentState,
          {
            iteration: nextIter,
            phase: 'coding',
            lastAuditResult: auditText || undefined,
            auditCount: newAuditCount,
          },
          continuationPrompt,
          assistantErrorDetected,
          'section retry continuation',
        )
        return
      }

      const candidateState = { ...currentState, auditCount: newAuditCount }

      // Capture outstanding findings before the auditor session is torn down by
      // termination, then emit one audit_done event describing this audit pass.
      const findingsBefore = loopService.getOutstandingFindings(currentState.loopName)
      const findingsBugsBefore = loopService.getOutstandingFindings(currentState.loopName, 'bug')
      const isClean = findingsBefore.length === 0
      const nextIteration = (currentState.iteration ?? 0) + 1
      const maxIterationsExceeded = (currentState.maxIterations ?? 0) > 0 && nextIteration > (currentState.maxIterations ?? 0)

      // Derive the audit outcome AFTER evaluating the iteration cap so the
      // single audit_done event reflects what actually happens next:
      //   clean        → terminate (auditor all-clear)
      //   dirty & cap   → max_iterations (loop will terminate, not continue)
      //   dirty & ok    → continue (remediation rotation follows)
      let auditOutcome: string
      let auditVerdict: 'clean' | 'dirty'
      if (isClean) {
        auditOutcome = 'terminate'
        auditVerdict = 'clean'
      } else if (maxIterationsExceeded) {
        auditOutcome = 'max_iterations'
        auditVerdict = 'dirty'
      } else {
        auditOutcome = 'continue'
        auditVerdict = 'dirty'
      }

      await metrics.recordPhaseEvent({
        state: candidateState,
        eventType: 'audit_done',
        outcome: auditOutcome,
        verdict: auditVerdict,
        sessionId: auditSessionId,
        directory: currentState.worktreeDir,
        role: 'auditor',
        findingsTotal: findingsBefore.length,
        findingsBugs: findingsBugsBefore.length,
        fallbackModel: getFallbackModelForSession(currentState, 'auditing'),
      })

      if (await checkAuditClearAndTerminate(loopName, candidateState)) return

      if (maxIterationsExceeded) {
        // Persist the bumped audit count before terminating so loop_runs.auditCount
        // reflects this dirty audit pass. Without this, terminateLoop records the
        // run with the pre-audit count (stale by one). Mirrors the sectioned
        // max_iterations terminal path.
        loopService.replaceSession(loopName, {
          newSessionId: currentState.sessionId,
          phase: currentState.phase,
          auditCount: newAuditCount,
        })
        await terminateLoop(loopName, candidateState, { kind: 'max_iterations' })
        return
      }

      const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')
      bumpDirtyAuditRecurrence(loopName, outstandingBugs)

      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...currentState, iteration: nextIteration },
        auditText || undefined,
        outstandingBugs,
      )

      await rotateAndSendContinuation(
        loopName,
        currentState,
        {
          iteration: nextIteration,
          phase: 'coding',
          lastAuditResult: auditText || undefined,
          auditCount: newAuditCount,
        },
        continuationPrompt,
        assistantErrorDetected,
        'coding continuation',
      )
    } else {
      logger.log(`Loop: audit error detected, continuing without incrementing audit count`)
      await metrics.recordPhaseEvent({
        state: currentState,
        eventType: 'audit_done',
        outcome: 'audit_error',
        sessionId: auditSessionId,
        directory: currentState.worktreeDir,
        role: 'auditor',
        fallbackModel: getFallbackModelForSession(currentState, 'auditing'),
      })
      const nextIteration = (currentState.iteration ?? 0) + 1
      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...currentState, iteration: nextIteration },
        auditText || undefined,
      )
      await rotateAndSendContinuation(
        loopName,
        currentState,
        {
          iteration: nextIteration,
          phase: 'coding',
          lastAuditResult: auditText || undefined,
          auditCount: currentState.auditCount ?? 0,
        },
        continuationPrompt,
        assistantErrorDetected,
        'coding continuation',
      )
    }
  }

  async function runFinalAuditPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping final audit phase`)
      return
    }

    if (currentState.phase !== 'final_auditing') {
      logger.log(`Loop: runFinalAuditPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in final audit phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const auditSessionId = currentState.sessionId

    const { text: auditText, error: assistantError, errorSignal: finalAuditErrorSignal, lastMessageRole } = await getLastAssistantInfo(auditSessionId, currentState.worktreeDir)

    // Classify persisted provider-limit errors before the no-assistant gate
    // so that finish:'error' assistant messages terminate immediately.
    if (finalAuditErrorSignal) {
      const limitReason = classifyProviderLimit(finalAuditErrorSignal)
      if (limitReason) {
        logger.error(`Loop: provider limit in persisted final audit error for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
        return
      }
    }

    if (await handleIdleNoAssistantGate(loopName, currentState, lastMessageRole, { phaseLabel: 'final audit phase', exhaustedReason: { kind: 'final_audit_retry_exhausted' }, rerun: runFinalAuditPhase })) return

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'final_auditing', finalAuditErrorSignal)
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'final_auditing')

    if (!assistantErrorDetected) {
      const hasOutstandingBugs = loopService.hasOutstandingFindings(loopName, 'bug')

      const trans = nextTransition(currentState, { type: hasOutstandingBugs ? 'final-audit-dirty' : 'final-audit-clean' })
      if (trans.kind === 'terminate') {
        logger.log(`Loop: final audit clean for ${loopName} (no outstanding bug findings), completing`)
        loopService.setFinalAuditDone(loopName, true)
        await metrics.recordPhaseEvent({
          state: currentState,
          eventType: 'final_audit_done',
          outcome: 'terminate',
          verdict: 'clean',
          sessionId: auditSessionId,
          directory: currentState.worktreeDir,
          role: 'auditor',
          fallbackModel: getFallbackModelForSession(currentState, 'final_auditing'),
        })
        if (trans.reason.kind === 'completed' && await enterPostActionPhase(loopName, currentState)) return
        await terminateLoop(loopName, currentState, trans.reason)
        return
      }

      // Dirty final audit: rotate to a coding session that fixes the findings,
      // then on coding idle return straight to final_auditing (no section rewind).
      const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')
      logger.log(`Loop: final audit dirty (${outstandingBugs.length} outstanding bug findings), rotating to coding for fix for ${loopName}`)

      const nextIter = (currentState.iteration ?? 0) + 1
      const maxIterationsExceeded = (currentState.maxIterations ?? 0) > 0 && nextIter > currentState.maxIterations
      await metrics.recordPhaseEvent({
        state: currentState,
        eventType: 'final_audit_done',
        outcome: maxIterationsExceeded ? 'max_iterations' : 'fix_rotation',
        verdict: 'dirty',
        sessionId: auditSessionId,
        directory: currentState.worktreeDir,
        role: 'auditor',
        findingsBugs: outstandingBugs.length,
        fallbackModel: getFallbackModelForSession(currentState, 'final_auditing'),
      })

      if (maxIterationsExceeded) {
        logger.log(`Loop: max iterations reached (${nextIter}/${currentState.maxIterations}), terminating`)
        await terminateLoop(loopName, currentState, { kind: 'max_iterations' })
        return
      }

      // Persist the audit text so recovery paths can rebuild the fix prompt if needed.
      if (auditText) loopService.setLastAuditResult(loopName, auditText)

      bumpDirtyAuditRecurrence(loopName, outstandingBugs)

      const fixPrompt = loopService.buildFinalAuditFixPrompt(currentState, auditText || '', outstandingBugs)

      let newCodeSessionId: string
      try {
        newCodeSessionId = await rotateSession(loopName, currentState, {
          iteration: nextIter,
        })
      } catch (err) {
        logger.error(`Loop: session rotation failed during final audit fix, aborting rotation`, err)
        return
      }

      // Mark this loop before phase/session transitions so any idle event observed
      // mid-rotation is handled as a final-audit fix.
      pendingFinalAuditFix.add(loopName)

      loopService.setPhase(loopName, 'coding')

      loopService.replaceSession(loopName, {
        newSessionId: newCodeSessionId,
        phase: 'coding',
        iteration: nextIter,
        resetError: currentState.errorCount > 0,
      })

      const { error: promptErr } = await sendPromptWithFallback({
        loopName,
        sessionId: newCodeSessionId,
        promptText: fixPrompt,
        agent: 'code',
        variant: currentState.executionVariant,
      })
      if (promptErr) {
        logger.error(`Loop: failed to send final-audit fix prompt for ${loopName}`, promptErr)
        pendingFinalAuditFix.delete(loopName)
        await handlePromptError(loopName, currentState, 'failed to send final-audit fix prompt', promptErr)
        return
      }
      watchdog.recordActivity(loopName, 'final-audit-fix-prompt-sent')
    }
  }

  async function runPostActionPhase(loopName: string, _state: LoopState): Promise<void> {
    const currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping post-action phase`)
      return
    }

    if (currentState.phase !== 'post_action') {
      logger.log(`Loop: runPostActionPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in post-action phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const { text: postActionText, lastMessageRole } = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)

    if (await handleIdleNoAssistantGate(loopName, currentState, lastMessageRole, { phaseLabel: 'post-action phase', exhaustedReason: { kind: 'completed' }, rerun: runPostActionPhase })) return

    logger.log(`Loop: post-action complete for ${loopName}, terminating`)
    const trans = nextTransition(currentState, { type: 'post-action-complete' })
    if (trans.kind === 'terminate') {
      // Persist the full assistant transcript of the post-action session before it is
      // deleted on termination, so the run's details survive (loop-status/dashboard).
      const report = await getAssistantTranscript(currentState.sessionId, currentState.worktreeDir)
      if (report) {
        loopService.setPostActionReport(loopName, report)
      }
      await metrics.recordPhaseEvent({
        state: currentState,
        eventType: 'post_action_done',
        outcome: 'terminate',
        sessionId: currentState.sessionId,
        directory: currentState.worktreeDir,
        role: 'code',
        fallbackModel: getFallbackModelForSession(currentState, 'coding'),
      })
      // Capture the raw post-action assistant message as the loop's completion summary so the
      // outcome (alternate review verdict, CI result, etc.) is visible in loop-status/dashboard.
      // The loop still terminates `completed` — the plan itself was already cleared by the audit.
      await terminateLoop(loopName, currentState, trans.reason, postActionText || undefined)
    }
  }

  /** Re-fetch the last message; run `onAssistant` if the assistant replied, otherwise `onNoAssistant`. */
  async function resumeOrFallback(
    loopName: string,
    state: LoopState,
    eventSessionId: string,
    onAssistant: (loopName: string, state: LoopState) => Promise<void>,
    onNoAssistant: (loopName: string, state: LoopState) => Promise<void>,
  ): Promise<void> {
    const { lastMessageRole } = await getLastAssistantInfo(eventSessionId, state.worktreeDir)
    if (lastMessageRole === 'assistant') { await onAssistant(loopName, state); return }
    await onNoAssistant(loopName, state)
  }

  async function tick(event: LoopEvent): Promise<void> {
    if (event.type === 'worktree.failed') {
      const message = event.properties?.message as string
      const directory = event.properties?.directory as string
      logger.error(`Loop: worktree failed: ${message}`)
      
      if (directory) {
        const activeLoops = loopService.listActive()
        const affectedLoop = activeLoops.find((s) => s.worktreeDir === directory)
        if (affectedLoop) {
          await terminateLoop(affectedLoop.loopName!, affectedLoop, { kind: 'worktree_failed', message })
        }
      }
      return
    }

    if (event.type === 'session.error') {
      const errorProps = event.properties as { sessionID?: string; error?: { name?: string; data?: { message?: string; statusCode?: number } } }
      const eventSessionId = errorProps?.sessionID
      const errorName = errorProps?.error?.name
      const isAbort = errorName === 'MessageAbortedError' || errorName === 'AbortError'

      if (!eventSessionId) return

      if (isAbort) {
        const loopName = loopService.resolveLoopName(eventSessionId)
        if (!loopName) return
        await withStateLock(loopName, async () => {
          const state = loopService.getActiveState(loopName)
          if (!state?.active) return
          const isCurrentSession = state.sessionId === eventSessionId
          if (!isCurrentSession) {
            logger.log(`Loop: ignoring stale aborted event for session ${eventSessionId} (current=${state.sessionId})`)
            return
          }
          if (state.phase === 'auditing') {
            await resumeOrFallback(loopName, state, eventSessionId,
              async (ln, s) => { logger.log(`Loop: audit session ${eventSessionId} aborted after assistant response, processing audit result`); await runAuditingPhase(ln, s) },
              async (ln, s) => { logger.log(`Loop: audit session ${eventSessionId} aborted, cleaning up and rolling back to coding`); await rotateToCodingAfterAuditFailure(ln, s, 'aborted') },
            )
            return
          }
          if (state.phase === 'final_auditing') {
            await resumeOrFallback(loopName, state, eventSessionId,
              async (ln, s) => { logger.log(`Loop: final audit session ${eventSessionId} aborted after assistant response, processing audit result`); await runFinalAuditPhase(ln, s) },
              async (ln, s) => { logger.log(`Loop: final audit session ${eventSessionId} aborted, cleaning up and rolling back to coding`); await rotateToCodingAfterAuditFailure(ln, s, 'aborted') },
            )
            return
          }
          if (state.phase === 'post_action') {
            await resumeOrFallback(loopName, state, eventSessionId,
              async (ln, s) => { logger.log(`Loop: post-action session ${eventSessionId} aborted after assistant response, processing result`); await runPostActionPhase(ln, s) },
              async (ln, s) => { logger.log(`Loop: post-action session ${eventSessionId} aborted without assistant response, terminating as completed (best-effort)`); await terminateLoop(ln, s, { kind: 'completed' }) },
            )
            return
          }
          logger.log(`Loop: session ${eventSessionId} aborted, terminating loop`)
          await terminateLoop(loopName, state, { kind: 'user_aborted' })
        })
        return
      }

      const loopName = await resolveSessionLoopName(eventSessionId)
      if (!loopName) return
      await withStateLock(loopName, async () => {
        const state = loopService.getActiveState(loopName)
        if (!state?.active) return

        const limitReason = classifyProviderLimit({
          name: errorName,
          message: errorProps?.error?.data?.message,
          statusCode: errorProps?.error?.data?.statusCode,
        })
        if (limitReason) {
          logger.error(`Loop: provider limit detected for ${loopName}: ${limitReason}, terminating`)
          await terminateLoop(loopName, state, { kind: 'provider_limit', message: limitReason })
          return
        }

        const isCurrentSession = state.sessionId === eventSessionId
        if (!isCurrentSession) {
          logger.log(`Loop: ignoring stale error event for session ${eventSessionId} (current=${state.sessionId})`)
          return
        }
        if (state.phase === 'auditing') {
          const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
          logger.error(`Loop: audit session error for ${eventSessionId}: ${errorMessage}, cleaning up and rolling back to coding`)
          await rotateToCodingAfterAuditFailure(loopName, state, errorMessage)
          return
        }
        const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
        if (state.phase === 'final_auditing') {
          const { lastMessageRole } = await getLastAssistantInfo(eventSessionId, state.worktreeDir)
          if (lastMessageRole === 'assistant') {
            logger.log(`Loop: final audit session ${eventSessionId} error after assistant response, processing audit result`)
            await runFinalAuditPhase(loopName, state)
            return
          }
          logger.error(`Loop: final audit session error for ${eventSessionId}: ${errorMessage}, cleaning up and rolling back to coding`)
          await rotateToCodingAfterAuditFailure(loopName, state, errorMessage)
          return
        }
        if (state.phase === 'post_action') {
          logger.error(`Loop: post-action session error for ${eventSessionId}: ${errorMessage}, completing as best-effort`)
          await terminateLoop(loopName, state, { kind: 'completed' })
          return
        }
        logger.error(`Loop: session error for ${eventSessionId}: ${errorMessage}`)
        const isModelError = /provider|auth|model|api\s*error/i.test(errorMessage)
        if (isModelError && !state.modelFailed) {
          logger.log(`Loop: marking model as failed, will fall back to default on next iteration`)
          loopService.setModelFailed(loopName, true)
        }
      })
      return
    }

    if (event.type !== 'session.status') return

    const status = event.properties?.status as { type?: string; attempt?: number; message?: string } | undefined
    const sessionId = event.properties?.sessionID as string
    if (!sessionId) return

    if (status?.type === 'busy') {
      const loopName = loopService.resolveLoopName(sessionId)
      if (loopName && isAwaitingBusy(loopName, sessionId)) {
        logger.debug(`[idle-gate] busy observed for ses=${sessionId} loop=${loopName}, clearing pending`)
        clearPromptPending(loopName, logger)
      }
      if (loopName) {
        clearPromptInFlightBySession(loopName, sessionId)
      }
      return
    }

    if (status?.type === 'retry') {
      const loopName = await resolveSessionLoopName(sessionId)
      if (!loopName) return
      const limitReason = classifyProviderLimit({ message: status.message })
      if (!limitReason) {
        logger.debug(`Loop: provider retry in progress for ${loopName} (attempt=${status.attempt ?? '?'})`)
        return
      }
      await withStateLock(loopName, async () => {
        const state = loopService.getActiveState(loopName)
        if (!state?.active) return
        logger.error(`Loop: provider limit detected via retry status for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, state, { kind: 'provider_limit', message: limitReason })
      })
      return
    }

    if (status?.type !== 'idle') return

    logger.debug(`Loop: received idle event for session=${sessionId}`)

    const loopName = loopService.resolveLoopName(sessionId)
    if (!loopName) {
      logger.debug(`Loop: no loop found for session=${sessionId}, ignoring idle event`)
      return
    }
    logger.debug(`Loop: idle event matched loop=${loopName}`)

    if (isAwaitingBusy(loopName, sessionId)) {
      if (!isAwaitingBusyExpired(loopName)) {
        logger.debug(`[idle-gate] suppressing premature idle loop=${loopName} session=${sessionId} (no busy yet)`)
        return
      }
      logger.log(`[idle-gate] awaiting-busy expired for loop=${loopName}, dispatching idle anyway`)
      clearPromptPending(loopName, logger)
    }

    await withStateLock(loopName, async () => {
      const state = loopService.getActiveState(loopName)
      if (!state || !state.active) return

      const isCurrentSession = state.sessionId === sessionId
      if (!isCurrentSession) {
        logger.log(`Loop: ignoring stale idle event for session ${sessionId} (current=${state.sessionId})`)
        return
      }

      try {
        watchdog.start(loopName)
        
        if (state.phase === 'auditing') {
          await runAuditingPhase(loopName, state)
        } else if (state.phase === 'final_auditing') {
          await runFinalAuditPhase(loopName, state)
        } else if (state.phase === 'post_action') {
          await runPostActionPhase(loopName, state)
        } else {
          await runCodingPhase(loopName, state)
        }
      } catch (err) {
        const freshState = loopService.getActiveState(loopName)
        await handlePromptError(loopName, freshState ?? state, `unhandled error in ${(freshState ?? state).phase} phase`, err)
      }
    })
  }

  async function terminateAll(): Promise<void> {
    // Route bulk shutdown through per-loop terminateLoop() so each loop records
    // its final usage capture, a loop_terminated metrics event, and a loop_runs
    // summary row. loopService.listActive() snapshots the active loops before
    // any termination runs; terminateLoop's terminatingLoops guard prevents double
    // execution if the loop is concurrently stopped by another path.
    const active = loopService.listActive()
    for (const state of active) {
      await terminateLoop(state.loopName, state, { kind: 'shutdown' })
    }
  }

  function clearAllRetryTimeouts(): void {
    for (const [worktreeName, timeout] of retryTimeouts.entries()) {
      clearTimeout(timeout)
      retryTimeouts.delete(worktreeName)
    }
    for (const [worktreeName, timeout] of idleRetryTimeouts.entries()) {
      clearTimeout(timeout)
      idleRetryTimeouts.delete(worktreeName)
    }
    idleRetryAttempts.clear()
    codingLaunchRecoveryAttempts.clear()
    loopRetainedSessions.clear()
    sessionToLoop.clear()
    terminatingLoops.clear()
    watchdog.clearAll()
    stateLocks.clear()
    sessionsAwaitingBusy.clear()
    logger.log('Loop: cleared all retry timeouts')
  }

  async function cancelBySessionId(sessionId: string): Promise<boolean> {
    const loopName = loopService.resolveLoopName(sessionId)
    if (!loopName) return false
    const state = loopService.getActiveState(loopName)
    if (!state?.active) return false
    await terminateLoop(loopName, state, { kind: 'user_aborted' })
    return true
  }

  async function terminateLoopByName(loopName: string, reason: TerminationReason): Promise<boolean> {
    const state = loopService.getActiveState(loopName)
    if (!state?.active) return false
    await terminateLoop(loopName, state, reason)
    return true
  }

  async function clearLoopTimers(loopName: string): Promise<void> {
    watchdog.stop(loopName)

    const retryTimeout = retryTimeouts.get(loopName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeouts.delete(loopName)
    }

    const idleRetryTimeout = idleRetryTimeouts.get(loopName)
    if (idleRetryTimeout) {
      clearTimeout(idleRetryTimeout)
      idleRetryTimeouts.delete(loopName)
    }
    idleRetryAttempts.delete(loopName)
    codingLaunchRecoveryAttempts.delete(loopName)
    terminatingLoops.delete(loopName)

    const retained = loopRetainedSessions.get(loopName)
    if (retained) {
      // Capture usage for retained sessions before deletion using stored metadata
      for (const entry of retained) {
        await captureLoopSessionUsage({
          loopName,
          sessionId: entry.sessionId,
          directory: entry.directory,
          role: entry.role,
          fallbackModel: entry.fallbackModel,
          runStartedAt: entry.runStartedAt,
        }).catch((err: unknown) => {
          logger.error(`Loop: failed to capture usage for retained session ${entry.sessionId} on clear (loop=${loopName})`, err)
        })
        void client.session.delete({ sessionID: entry.sessionId, directory: entry.directory }).catch(() => {})
      }
      loopRetainedSessions.delete(loopName)
    }
  }

  function runExclusive<T>(loopName: string, fn: () => Promise<T>): Promise<T> {
    return withStateLock<T>(loopName, fn)
  }

  function inspect(name: string): LoopState | null {
    return loopService.getAnyState(name)
  }

  function listActive(): LoopState[] {
    return loopService.listActive()
  }

  function listRecent(): LoopState[] {
    return loopService.listRecent()
  }

  function findMatchByName(name: string): { match: LoopState | null; candidates: LoopState[] } {
    return loopService.findMatchByName(name)
  }

  function hasOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): boolean {
    return loopService.hasOutstandingFindings(loopName, severity)
  }

  async function cancel(name: string): Promise<void> {
    await terminateLoopByName(name, { kind: 'user_aborted' })
  }

  async function terminate(name: string, reason: TerminationReason): Promise<boolean> {
    return await terminateLoopByName(name, reason)
  }

  function recordActivity(name: string, source?: string): void {
    watchdog.recordActivity(name, source)
  }

  function startWatchdog(name: string): void {
    watchdog.start(name)
  }

  function getStallInfo(name: string): LoopWatchdogStallInfo | null {
    return watchdog.getStallInfo(name)
  }

  function generateUniqueLoopName(baseName: string): string {
    const existing = listActive()
      .map(s => s.loopName)
    const recent = listRecent()
      .map(s => s.loopName)
    return generateUniqueName(baseName, [...existing, ...recent])
  }

  function start(input: StartLoopInput): void {
    const { state } = input

    const allNames = [...listActive(), ...listRecent()].map(s => s.loopName)
    if (allNames.includes(state.loopName)) {
      state.loopName = generateUniqueName(state.loopName, allNames)
      logger.log(`Loop: auto-renamed to ${state.loopName} because requested name already exists`)
    }

    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)
    sessionToLoop.set(state.sessionId, state.loopName)
    loopRegistry.add(state.loopName)
    logger.log(`Loop: started loop=${state.loopName} session=${state.sessionId}`)
  }

  function restart(name: string, params: { newState: LoopState; newSessionId: string }): void {
    // Retain the old session in the reverse index before deleting state so that
    // delayed errors from the pre-restart session still resolve to this loop.
    const oldState = loopService.getAnyState(name)
    loopService.deleteState(name)
    loopService.setState(name, params.newState)
    loopService.registerLoopSession(params.newSessionId, name)
    sessionToLoop.set(params.newSessionId, name)
    if (oldState?.sessionId) {
      sessionToLoop.set(oldState.sessionId, name)
    }
    loopRegistry.add(name)
  }

  function setPhase(name: string, phase: LoopState['phase']): void {
    loopService.setPhase(name, phase)
  }

  /**
   * Populate the in-memory reverse index for a session that was registered
   * through a path that does not call {@link start} (e.g. production execution
   * service via {@link attachLoopToSession}). This ensures stale-session error
   * events can still resolve their loop after session rotation.
   */
  function registerSessionReverseIndex(sessionId: string, loopName: string): void {
    sessionToLoop.set(sessionId, loopName)
  }

  function unregisterSessionReverseIndex(sessionId: string): void {
    sessionToLoop.delete(sessionId)
  }

  return {
    tick,
    start,
    cancel,
    inspect,
    listActive,
    listRecent,
    findMatchByName,
    hasOutstandingFindings,
    terminateAll,
    terminate,
    cancelBySessionId,
    runExclusive,
    clearLoopTimers,
    clearAllRetryTimeouts,
    recordActivity,
    startWatchdog,
    getStallInfo,
    restart,
    finalizeRunForRestart,
    generateUniqueLoopName,
    setPhase,
    registerSessionReverseIndex,
    unregisterSessionReverseIndex,
    setParentSessionLookup(lookup: (sessionId: string) => Promise<string | null>) {
      getParentSessionId = lookup
    },
    service: loopService,
  }
}
