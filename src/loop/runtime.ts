import type { ForgeClient } from '../client/port'
import type { LoopChangeNotifier, LoopService } from './service'
import { createLoopService, MAX_RETRIES } from './service'
import { generateUniqueName } from './name-uniqueness'
import type { LoopState } from './state'
import { transitionSectionIndex } from './state'
import type { Logger, PluginConfig, LoopConfig } from '../types'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo, ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { LoopTransitionsRepo } from '../storage/repos/loop-transitions-repo'
import type { PlanAmendmentsRepo } from '../storage/repos/plan-amendments-repo'
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
import { nextTransition, type TransitionEvent, type Transition } from './transitions'
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
  loopTransitionsRepo?: LoopTransitionsRepo
  planAmendmentsRepo?: PlanAmendmentsRepo
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
  const { loopsRepo, plansRepo, reviewFindingsRepo, projectId, client, logger, getConfig, onTerminated, notify, loopConfig, sectionPlansRepo, loopSessionUsageRepo, loopTransitionsRepo, planAmendmentsRepo } = deps

  // `runExclusive` (the in-loop lock using withStateLock) is declared later
  // in this function but is hoisted, so it's always available here.
  const loopService = deps.loopService ?? createLoopService(
    loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger, loopConfig, notify, sectionPlansRepo, loopTransitionsRepo, planAmendmentsRepo, runExclusive,
  )
  let getParentSessionId = deps.getParentSessionId

  const { getFallbackModelForSession, captureLoopSessionUsage } = createUsageCapture({ client, logger, getConfig, projectId, loopSessionUsageRepo })

  const { sendPromptWithFallback, getLastAssistantInfo, getAssistantTranscript } = createPromptDispatch({ client, logger, getConfig, loopService })

  const retryTimeouts = new Map<string, NodeJS.Timeout>()
  const idleRetryTimeouts = new Map<string, NodeJS.Timeout>()
  const idleRetryAttempts = new Map<string, number>()
  const stateLocks = new Map<string, Promise<unknown>>()

  const IDLE_RETRY_DELAY_MS = 1500
  const MAX_IDLE_RETRIES = 1
  const MAX_CODE_LAUNCH_RECOVERIES = MAX_RETRIES

  const codingLaunchRecoveryAttempts = new Map<string, number>()
  interface RetainedSessionMeta {
    sessionId: string
    role: 'code' | 'auditor'
    fallbackModel: string | undefined
    directory: string
  }
  const loopRetainedSessions = new Map<string, RetainedSessionMeta[]>()
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
   * Optional metadata passed into shared commit helpers (rotateAndSendContinuation,
   * startFinalAuditTransition) so the non-terminal transition row is recorded
   * AFTER the persisted phase commit but BEFORE the prompt send. Logging between
   * those two points guarantees (a) no phantom row when phase persistence fails
   * and (b) the row's id precedes any terminate row produced by a downstream
   * prompt-send failure (chronological id order).
   */
  type TransitionLogEntry = {
    eventType: string
    transitionKind: string
    fromPhase: LoopState['phase']
    toPhase: LoopState['phase'] | null
  }

  function recordTransitionEntry(
    loopName: string,
    state: LoopState,
    entry: TransitionLogEntry,
    overrideIter?: number,
    overrideSection?: number | null,
  ): void {
    loopService.recordTransition(loopName, {
      eventType: entry.eventType,
      transitionKind: entry.transitionKind,
      fromPhase: entry.fromPhase,
      toPhase: entry.toPhase,
      iteration: overrideIter ?? state.iteration ?? 0,
      sectionIndex: overrideSection ?? transitionSectionIndex(state),
    })
  }

  /**
   * Persist a non-terminal phase transition derived from a `nextTransition` result.
   * Terminal transitions are logged inside `terminateLoop` (whose `terminatingLoops`
   * admission guard is the single source of truth for terminal rows), so callers
   * MUST only invoke this helper for `continue`/`rotate`/`advance-section`/
   * `rewind-section`/`fix-for-final-audit`/`start-final-audit` outcomes.
   * `noop` outcomes produce no row.
   *
   * NOTE: callers must invoke this AFTER the corresponding phase persistence
   * (replaceSession / setPhase) succeeds. For paths routed through
   * `rotateAndSendContinuation` or `startFinalAuditTransition`, pass the
   * transition descriptor into those helpers instead so the row lands between
   * the phase commit and the prompt send.
   */
  function logTransition(
    loopName: string,
    state: LoopState,
    event: TransitionEvent,
    trans: Transition,
    toPhase: LoopState['phase'] | null,
  ): void {
    if (trans.kind === 'noop' || trans.kind === 'terminate') return
    recordTransitionEntry(loopName, state, {
      eventType: event.type,
      transitionKind: trans.kind,
      fromPhase: state.phase,
      toPhase,
    })
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
    const trans = nextTransition(currentState, { type: 'audit-clear' })
    if (trans.kind !== 'terminate') return false
    logger.log(`Loop: audit all-clear, terminating loop=${loopName} iteration=${currentState.iteration} audits=${currentState.auditCount ?? 0}`)
    if (trans.reason.kind === 'completed' && await enterPostActionPhase(loopName, currentState)) {
      // The post_action entry row is logged inside enterPostActionPhase (after
      // the persisted phase commit, before the prompt send) so a prompt-send
      // failure cannot insert a terminal row before the phase row.
      return true
    }
    await terminateLoop(loopName, currentState, trans.reason)
    logger.log(`Loop completed: auditor all-clear at iteration ${currentState.iteration} (audits=${currentState.auditCount ?? 0})`)
    return true
  }

  /**
   * Applies the iteration-cap transition; returns the next iteration or null if terminated.
   * Single source of truth for the maxIterations check so every path routes through
   * `nextTransition({ type: 'iteration-cap' })` instead of inline divergent checks.
   *
   * Callers that need to persist side-effects before terminating (e.g. the goal
   * path persists audit metadata) pass an `onTerminate` wrapper; otherwise the
   * default `terminateLoop` is used.
   */
  async function nextIterationOrTerminate(
    loopName: string,
    state: LoopState,
    onTerminate?: (reason: TerminationReason) => Promise<void>,
  ): Promise<number | null> {
    const nextIter = (state.iteration ?? 0) + 1
    if ((state.maxIterations ?? 0) > 0 && nextIter > state.maxIterations) {
      logger.log(`Loop: max iterations reached (${nextIter}/${state.maxIterations}), terminating`)
      const trans = nextTransition(state, { type: 'iteration-cap' })
      if (trans.kind === 'terminate') {
        if (onTerminate) await onTerminate(trans.reason)
        else await terminateLoop(loopName, state, trans.reason)
      }
      return null
    }
    return nextIter
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

    // Record the *entry* into post_action here — after the persisted phase commit
    // AND before sending the post-action prompt. If the prompt send fails below,
    // terminateLoop is invoked from inside this helper and would otherwise insert
    // its terminal row before the entry row, reversing chronological id order.
    // The source event type mirrors the audit-clear/final-audit-clean verdict
    // that drove the redirect; both reduce to "phase" non-terminal rows.
    const sourceEventType = currentState.phase === 'final_auditing' ? 'final-audit-clean' : 'audit-clear'
    loopService.recordTransition(loopName, {
      eventType: sourceEventType,
      transitionKind: 'phase',
      fromPhase: currentState.phase,
      toPhase: 'post_action',
      iteration: currentState.iteration ?? 0,
      sectionIndex: transitionSectionIndex(currentState),
    })

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

    loopService.replaceSession(loopName, {
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

  async function rotateToCodingAfterAuditFailure(loopName: string, state: LoopState, reason: string, eventType: string): Promise<void> {
    const newSessionId = await rotateSession(loopName, state)

    loopService.replaceSession(loopName, {
      newSessionId,
      phase: 'coding',
      resetError: false,
      ...(state.kind === 'goal' ? { executorSessionId: newSessionId } : {}),
    })
    // Record the recovery transition AFTER the persisted phase commit to coding
    // so the abort/error → coding phase change is captured consistently.
    loopService.recordTransition(loopName, {
      eventType,
      transitionKind: 'error-recovery',
      fromPhase: state.phase,
      toPhase: 'coding',
      iteration: state.iteration ?? 0,
      sectionIndex: transitionSectionIndex(state),
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
    if (state.phase === 'final_audit_fix') {
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
    
    queue.push({ sessionId, role, fallbackModel, directory })
    loopRetainedSessions.set(loopName, queue)
    logger.debug(`Loop: queued session ${sessionId} for retention (loop=${loopName}, context=${context}, queue=${queue.length})`)

    while (queue.length > SESSION_RETENTION) {
      const oldest = queue.shift()!
      logger.log(`Loop: trimming session ${oldest.sessionId} (loop=${loopName}, retention=${SESSION_RETENTION})`)
      
      // Capture usage before deletion using stored metadata
      await captureLoopSessionUsage({
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
    // Adopt the authoritative under-lock state for every downstream side
    // effect (usage capture, persistence, terminal transition, host teardown).
    // The caller's snapshot can lag phase rotations (e.g. final_auditing ->
    // final_audit_fix) that happened between the caller observing the state
    // and terminateLoop acquiring the admission guard; using the stale
    // snapshot would record the wrong fromPhase/iteration/section/session.
    state = current

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
    })

    const now = Date.now()
    loopService.terminate(loopName, {
      status: terminationStatusFor(reason),
      reason: terminationReasonToString(reason),
      completedAt: now,
      summary,
    })

    // Record the terminal transition. This sits inside the `terminatingLoops`
    // admission guard above so concurrent terminate attempts produce at most one
    // row. Captures every bypass path (cancel/stall/provider-limit/watchdog/
    // missing-worktree) that never flows through `nextTransition`.
    loopService.recordTerminalTransition(loopName, {
      reason,
      fromPhase: state.phase,
      iteration: state.iteration ?? 0,
      sectionIndex: transitionSectionIndex(state),
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
        const retryTimeout = setTimeout(() => {
          // Serialize the retry send and its failure/exhaustion handling with
          // phase-rotation ticks (which also acquire the per-loop state
          // lock). Without this guard, a delayed retry could fire its send
          // and (on failure) its exhausted termination concurrently with a
          // phase rotation, racing the terminal row's fromPhase against the
          // rotation's persisted phase and corrupting transition ordering.
          // Holding the lock for the duration of the retry attempt and the
          // recursive handlePromptError (which may terminate) guarantees
          // any concurrent tick queues behind us and observes the
          // authoritative post-retry state when it eventually runs. Inside
          // the lock body, handlePromptError's `terminateLoop` runs nested
          // without re-acquiring the lock (terminateLoop never wraps itself
          // in withStateLock — only its public callers do), so there is no
          // nested-lock deadlock.
          void withStateLock(loopName, async () => {
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
          })
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
        await phaseRunners[freshState.phase](loopName, freshState)
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

  /**
   * Persist the loop's transition into the final_auditing phase: provision an
   * auditor session, replace the loop's active session, and send the final
   * audit prompt. Returns false if the auditor session could not be created
   * or the prompt could not be sent (caller leaves the loop in its prior phase).
   *
   * When `transition` is supplied, the non-terminal transition row is recorded
   * AFTER `replaceSession` (the persisted phase commit) and BEFORE the prompt
   * send. This leaves no phantom row when session creation fails (returns false
   * before persistence), and guarantees the transition row's id precedes any
   * terminate row produced by a downstream prompt-send failure.
   */
  async function startFinalAuditTransition(
    loopName: string,
    currentState: LoopState,
    transition?: TransitionLogEntry,
  ): Promise<boolean> {
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

    // Record the transition row only after the phase commit above succeeded and
    // before the prompt send below: a failed prompt may itself terminate the
    // loop, and the row's id must precede that terminate row.
    if (transition) {
      recordTransitionEntry(loopName, currentState, transition)
    }

    // The retired session is a code session (pre-final-audit)
    void scheduleSessionDelete({ loopName, sessionId: currentState.sessionId, directory: currentState.worktreeDir, context: 'after final audit creation', phase: 'coding', state: currentState })

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
    loopService.setCoderDecisions(loopName, parseCoderDecisions(assistantInfo.text))

    // Phase-runner dispatch (see phaseRunners below) routes a final_audit_fix loop
    // to runFinalAuditFixPhase, so runCodingPhase only handles the regular coding phase.
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

    // Consult the pure transition table for the coding→auditing rotation.
    // Every phase change must flow through nextTransition so the table is the
    // single source of truth (fixed finding runtime.ts:1369).
    const idleTrans = nextTransition(currentState, { type: 'coding-idle-complete' })
    if (idleTrans.kind === 'terminate') {
      await terminateLoop(loopName, currentState, idleTrans.reason)
      return
    }
    if (idleTrans.kind !== 'rotate') {
      return
    }

    // Retain the old session in the reverse index so delayed errors from the
    // pre-transition session still resolve to this loop after DB-level replacement.
    sessionToLoop.set(codeSessionId, loopName)
    loopService.replaceSession(loopName, {
      newSessionId: created.auditSessionId,
      phase: 'auditing',
    })
    sessionToLoop.set(created.auditSessionId, loopName)

    // Record the coding→auditing rotation derived from the pure transition
    // table.  logTransition (non-terminal-only wrapper) writes the row.
    logTransition(loopName, currentState, { type: 'coding-idle-complete' }, idleTrans, 'auditing')

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
    if (outstandingFindings.length === 0) {
      logger.log(`Loop: goal audit all-clear, terminating loop=${loopName} audits=${newAuditCount}`)
      const clearTrans = nextTransition(currentState, { type: 'audit-clear' })
      if (clearTrans.kind === 'terminate') {
        await persistAuditAndTerminate(clearTrans.reason)
      }
      return
    }

    const nextIteration = await nextIterationOrTerminate(loopName, currentState, persistAuditAndTerminate)
    if (nextIteration === null) return

    const dirtyTrans = nextTransition(currentState, { type: 'audit-dirty' })
    if (dirtyTrans.kind !== 'continue') return

    const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')
    bumpDirtyAuditRecurrence(loopName, outstandingBugs)

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

    // Record the audit-dirty → coding rotate AFTER the persisted phase commit
    // above and BEFORE the prompt send below. A prompt-send failure that
    // terminates the loop will then produce a terminate row whose id strictly
    // follows this rotate row (chronological id order).
    logTransition(loopName, currentState, { type: 'audit-dirty' }, dirtyTrans, 'coding')

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
        const sectionAllBugFindings = loopService.getOutstandingFindings(loopName, 'bug')
        const sectionBugFindings = sectionAllBugFindings.filter(f => f.sectionIndex === idx)

        if (sectionSummary && sectionBugFindings.length === 0) {
          logger.log(`Loop: section ${idx} audit clean, marking completed`)

          // Reset recurrence for this section so resolved findings don't falsely escalate later
          loopService.resetSectionRecurrence(loopName, idx)

          loopService.setLastAuditResult(loopName, auditText || '')
          loopService.completeSection(loopName, idx, sectionSummary)

          // Pre-check: rewind fast-path — all sections completed even though we
          // are not on the last one (possible after a rewind). This bypasses the
          // transition event because `isLastSection` would be false here, but the
          // correct destination is still final-audit. Synthesize the same
          // section-clean / isLastSection=true transition the regular path would
          // have produced and log it so the persisted phase change is recorded.
          if (idx < currentState.totalSections - 1) {
            const allCompleted = loopService.getCompletedSectionDigest(currentState).length === currentState.totalSections
            if (allCompleted) {
              logger.log(`Loop: all ${currentState.totalSections} sections completed after rewind, jumping straight to final audit`)
              // Same guard as the regular path: prevent skipping appended sections.
              const rewindFresh = loopsRepo.get(projectId, currentState.loopName ?? '')
              if (rewindFresh && rewindFresh.totalSections > currentState.totalSections) {
                logger.log(`Loop: amendment appended sections after rewind jump; staying for re-audit`)
                return
              }
              const rewindEvent: TransitionEvent = { type: 'section-clean', isLastSection: true }
              const rewindTrans = nextTransition(currentState, rewindEvent)
              if (rewindTrans.kind === 'start-final-audit') {
                await startFinalAuditTransition(loopName, currentState, {
                  eventType: rewindEvent.type,
                  transitionKind: rewindTrans.kind,
                  fromPhase: currentState.phase,
                  toPhase: 'final_auditing',
                })
              }
              return
            }
          }

          const isLastSection = idx >= currentState.totalSections - 1
          const sectionEvent: TransitionEvent = { type: 'section-clean', isLastSection }
          const sectionTrans = nextTransition(currentState, sectionEvent)
          if (sectionTrans.kind === 'start-final-audit') {
            // Guard: prevent premature final-audit transition when an amendment
            // appended sections after the one we just finished. Without this check,
            // newly appended work at the former final position could be skipped.
            const freshRowForAudit = loopsRepo.get(projectId, currentState.loopName ?? '')
            if (freshRowForAudit && freshRowForAudit.totalSections > currentState.totalSections) {
              logger.log(`Loop: amendment appended sections at index ${idx + 1}; staying in section ${idx} for re-audit`)
              return
            }
            logger.log(`Loop: all ${currentState.totalSections} sections completed, transitioning to final-audit`)
            await startFinalAuditTransition(loopName, currentState, {
              eventType: sectionEvent.type,
              transitionKind: sectionTrans.kind,
              fromPhase: currentState.phase,
              toPhase: 'final_auditing',
            })
            return
          }
          if (sectionTrans.kind === 'advance-section') {
            const nextIdx = idx + 1
            const nextIter = await nextIterationOrTerminate(loopName, currentState)
            if (nextIter === null) return

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
              {
                eventType: sectionEvent.type,
                transitionKind: sectionTrans.kind,
                fromPhase: currentState.phase,
                toPhase: 'coding',
              },
            )
            return
          }
          return
        }

        const dirtyTrans = nextTransition(currentState, { type: 'section-dirty' })
        if (dirtyTrans.kind !== 'rotate') return

        logger.log(`Loop: section ${idx} audit dirty, retrying same section`)

        const nextIter = await nextIterationOrTerminate(loopName, currentState)
        if (nextIter === null) return

        loopService.incrementSectionAttempts(loopName, idx)

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
          {
            eventType: 'section-dirty',
            transitionKind: dirtyTrans.kind,
            fromPhase: currentState.phase,
            toPhase: 'coding',
          },
        )
        return
      }

      const candidateState = { ...currentState, auditCount: newAuditCount }
      if (await checkAuditClearAndTerminate(loopName, candidateState)) return

      const dirtyTrans = nextTransition(candidateState, { type: 'audit-dirty' })
      if (dirtyTrans.kind !== 'continue') return

      const nextIteration = await nextIterationOrTerminate(loopName, currentState)
      if (nextIteration === null) return

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
        {
          eventType: 'audit-dirty',
          transitionKind: dirtyTrans.kind,
          fromPhase: candidateState.phase,
          toPhase: 'coding',
        },
      )
    } else {
      logger.log(`Loop: audit error detected, continuing without incrementing audit count`)
      const nextIteration = await nextIterationOrTerminate(loopName, currentState)
      if (nextIteration === null) return
      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...currentState, iteration: nextIteration },
        auditText || undefined,
      )
      // Pass the recovery transition into the shared helper so the row is
      // recorded after the rotate-to-coding phase commit but before the prompt
      // send; a prompt failure that terminates the loop will then produce a
      // terminate row whose id strictly follows this recovery row.
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
        {
          eventType: 'audit-error',
          transitionKind: 'error-recovery',
          fromPhase: 'auditing',
          toPhase: 'coding',
        },
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

    // Guard: when an amendment appended sections while we're in final_auditing
    // (e.g., the transition to this phase happened from a stale snapshot),
    // revert back to auditing so the appended sections get executed.
    const freshAuditRow = loopsRepo.get(projectId, loopName)
    if (freshAuditRow && freshAuditRow.totalSections > (currentState.totalSections ?? 0)) {
      logger.log(`Loop: amendment appended sections while in final_auditing; reverting to auditing at section ${currentState.currentSectionIndex}`)
      // Route through the recording setPhase wrapper (not loopService.setPhase)
      // so the revert satisfies the "every phase change produces exactly one
      // loop_transitions row" invariant.
      setPhase(loopName, 'auditing')
      loopService.incrementSectionAttempts(loopName, currentState.currentSectionIndex ?? 0)
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

      const finalAuditEvent: TransitionEvent = { type: hasOutstandingBugs ? 'final-audit-dirty' : 'final-audit-clean' }
      const trans = nextTransition(currentState, finalAuditEvent)
      if (trans.kind === 'terminate') {
        logger.log(`Loop: final audit clean for ${loopName} (no outstanding bug findings), completing`)
        loopService.setFinalAuditDone(loopName, true)
        if (trans.reason.kind === 'completed' && await enterPostActionPhase(loopName, currentState)) {
          // The post_action entry row is logged inside enterPostActionPhase
          // (after the persisted phase commit, before the prompt send).
          return
        }
        await terminateLoop(loopName, currentState, trans.reason)
        return
      }

      // Dirty final audit: rotate to a coding session that fixes the findings,
      // then on coding idle return straight to final_auditing (no section rewind).
      // The transition row is logged AFTER the iteration-cap check and the
      // persisted phase change succeed so a cap-terminate or rotation failure
      // never leaves a phantom final_audit_fix row behind.
      const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')
      logger.log(`Loop: final audit dirty (${outstandingBugs.length} outstanding bug findings), rotating to coding for fix for ${loopName}`)

      const nextIter = await nextIterationOrTerminate(loopName, currentState)
      if (nextIter === null) return

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

      // Persist the new phase so the persisted state machine drives dispatch on the
      // next idle event. replaceSession atomically swaps the session and the phase.
      loopService.replaceSession(loopName, {
        newSessionId: newCodeSessionId,
        phase: 'final_audit_fix',
        iteration: nextIter,
        resetError: currentState.errorCount > 0,
      })

      // Record the final_auditing → final_audit_fix transition only after the
      // persisted phase commit above succeeds.
      logTransition(loopName, currentState, finalAuditEvent, trans, 'final_audit_fix')

      const { error: promptErr } = await sendPromptWithFallback({
        loopName,
        sessionId: newCodeSessionId,
        promptText: fixPrompt,
        agent: 'code',
        variant: currentState.executionVariant,
      })
      if (promptErr) {
        logger.error(`Loop: failed to send final-audit fix prompt for ${loopName}`, promptErr)
        // Roll back to the coding phase so subsequent idle/error handling treats the
        // loop as a regular coding pass rather than re-attempting the fix dispatch.
        loopService.setPhase(loopName, 'coding')
        // Record the recovery to coding; the persisted phase just changed via setPhase.
        loopService.recordTransition(loopName, {
          eventType: 'final-audit-fix-prompt-error',
          transitionKind: 'error-recovery',
          fromPhase: 'final_audit_fix',
          toPhase: 'coding',
          iteration: nextIter,
          sectionIndex: transitionSectionIndex(currentState),
        })
        await handlePromptError(loopName, currentState, 'failed to send final-audit fix prompt', promptErr)
        return
      }
      watchdog.recordActivity(loopName, 'final-audit-fix-prompt-sent')
    }
  }

  async function runFinalAuditFixPhase(loopName: string, _state: LoopState): Promise<void> {
    let currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} no longer active, skipping final-audit-fix phase`)
      return
    }

    if (currentState.phase !== 'final_audit_fix') {
      logger.log(`Loop: runFinalAuditFixPhase invoked while phase=${currentState.phase} for ${loopName}, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in final-audit-fix phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const assistantInfo = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)
    const lastMessageRole = assistantInfo.lastMessageRole

    // Classify persisted provider-limit errors before the no-assistant gate.
    if (assistantInfo.errorSignal) {
      const limitReason = classifyProviderLimit(assistantInfo.errorSignal)
      if (limitReason) {
        logger.error(`Loop: provider limit in persisted final-audit-fix error for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
        return
      }
    }

    if (await handleIdleNoAssistantGate(loopName, currentState, lastMessageRole, { phaseLabel: 'final-audit-fix phase', exhaustedReason: { kind: 'coding_no_assistant' }, rerun: runFinalAuditFixPhase })) return

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantInfo.error, 'coding', assistantInfo.errorSignal)
    if (!errorResult) return
    currentState = errorResult.currentState
    currentState = resetErrorCountIfNeeded(loopName, currentState, errorResult.assistantErrorDetected, 'coding')

    // Persist coder decisions emitted during the fix pass so the next final audit
    // prompt can surface them alongside the audit findings.
    loopService.setCoderDecisions(loopName, parseCoderDecisions(assistantInfo.text))

    const trans = nextTransition(currentState, { type: 'coding-idle-complete' })
    if (trans.kind === 'start-final-audit') {
      logger.log(`Loop: final-audit fix coding complete for ${loopName}, transitioning back to final_auditing`)
      const started = await startFinalAuditTransition(loopName, currentState, {
        eventType: 'coding-idle-complete',
        transitionKind: trans.kind,
        fromPhase: currentState.phase,
        toPhase: 'final_auditing',
      })
      if (!started) {
        logger.error(`Loop: failed to restart final audit after fix for ${loopName}`)
      }
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

  // Single source of truth for idle/watchdog dispatch. Every persisted phase maps to
  // exactly one phase runner; new phases must be added here to be reachable.
  const phaseRunners: Record<LoopState['phase'], (loopName: string, state: LoopState) => Promise<void>> = {
    coding: runCodingPhase,
    auditing: runAuditingPhase,
    final_auditing: runFinalAuditPhase,
    final_audit_fix: runFinalAuditFixPhase,
    post_action: runPostActionPhase,
  }

  async function tick(event: LoopEvent): Promise<void> {
    if (event.type === 'worktree.failed') {
      const message = event.properties?.message as string
      const directory = event.properties?.directory as string
      logger.error(`Loop: worktree failed: ${message}`)
      
      if (directory) {
        const activeLoops = loopService.listActive()
        const affectedLoop = activeLoops.find((s) => s.worktreeDir === directory)
        if (affectedLoop?.loopName) {
          // Serialize with phase-rotation ticks (which also acquire the state
          // lock). Without this guard, a tick could rotate the phase (and
          // commit its row) between the time we read the affectedLoop snapshot
          // and the time terminateLoop records the terminal row from that stale
          // snapshot — yielding a phase-transition row AFTER the terminal row
          // and a stale terminal fromPhase. Holding the lock for the duration
          // of terminateLoop guarantees the authoritative under-lock state
          // observed inside terminateLoop is the persisted phase at termination
          // time, so the terminal row's fromPhase matches the persisted phase
          // exactly and no rotation row lands after the terminal row.
          await withStateLock(affectedLoop.loopName, async () => {
            const state = loopService.getActiveState(affectedLoop.loopName!)
            if (!state?.active) return
            await terminateLoop(affectedLoop.loopName!, state, { kind: 'worktree_failed', message })
          })
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
              async (ln, s) => { logger.log(`Loop: audit session ${eventSessionId} aborted, cleaning up and rolling back to coding`); await rotateToCodingAfterAuditFailure(ln, s, 'aborted', 'audit-session-aborted') },
            )
            return
          }
          if (state.phase === 'final_auditing') {
            await resumeOrFallback(loopName, state, eventSessionId,
              async (ln, s) => { logger.log(`Loop: final audit session ${eventSessionId} aborted after assistant response, processing audit result`); await runFinalAuditPhase(ln, s) },
              async (ln, s) => { logger.log(`Loop: final audit session ${eventSessionId} aborted, cleaning up and rolling back to coding`); await rotateToCodingAfterAuditFailure(ln, s, 'aborted', 'final-audit-session-aborted') },
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
          // coding and final_audit_fix share the default abort handling: a coding-style
          // session aborted by the user terminates the loop as user_aborted. Intentional
          // fall-through — final_audit_fix is a coding pass driving the fix prompt.
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
          await rotateToCodingAfterAuditFailure(loopName, state, errorMessage, 'audit-session-error')
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
          await rotateToCodingAfterAuditFailure(loopName, state, errorMessage, 'final-audit-session-error')
          return
        }
        if (state.phase === 'post_action') {
          logger.error(`Loop: post-action session error for ${eventSessionId}: ${errorMessage}, completing as best-effort`)
          await terminateLoop(loopName, state, { kind: 'completed' })
          return
        }
        // coding and final_audit_fix share the default error handling: surface the
        // error, flag a model failure when applicable, and let the next idle/error
        // event drive recovery. Intentional fall-through — no phase-specific branch.
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

        await phaseRunners[state.phase](loopName, state)
      } catch (err) {
        const freshState = loopService.getActiveState(loopName)
        await handlePromptError(loopName, freshState ?? state, `unhandled error in ${(freshState ?? state).phase} phase`, err)
      }
    })
  }

  async function terminateAll(): Promise<void> {
    // Serialize each per-loop shutdown operation so an in-flight phase runner
    // (idle tick, watchdog recovery, retry timer, etc.) holding the per-loop
    // state lock cannot commit a phase transition row AFTER our shutdown row.
    // Without this guard, a phase runner paused mid-rotation while shutdown
    // fires would record its rotate row out-of-order (its id could exceed our
    // shutdown row's id, and our shutdown row's fromPhase would reflect a
    // pre-rotation phase rather than the persisted phase at shutdown time).
    //
    // Each sweep runs two passes per fresh snapshot:
    //
    // 1. Eager synchronous pass for uncontended loops (no entry in `stateLocks`
    //    means no in-flight tick holds the lock for that loop): admit into
    //    `terminatingLoops`, re-read authoritative state, record the shutdown
    //    row, and persist the cancellation synchronously. This fires the
    //    'terminate' notify inline so callers/tests that synchronously inspect
    //    notify state see the result without awaiting (parity with the prior
    //    bulk-cancel semantics). JS is single-threaded, so even if a tick
    //    fires concurrently during this synchronous body, its lock acquisition
    //    is microtask-scheduled and cannot interleave our synchronous work.
    //
    // 2. Deferred locked pass for contended loops (`stateLocks.has(name)` is
    //    true, meaning an in-flight tick already holds/queued the lock): we
    //    queue behind that lock with `withStateLock`. When the tick finishes
    //    (potentially recording a rotate row), our queued body acquires the
    //    lock, re-reads authoritative state, and records the shutdown row with
    //    the correct post-rotation phase. Ids are guaranteed in chronological
    //    order because the rotate row is recorded while the tick holds the
    //    lock and our shutdown row is recorded only after the tick releases.
    //
    // Loops already admitted by a canonical `terminateLoop` call (present in
    // `terminatingLoops`) have an in-flight canonical termination that will
    // record its own terminal row under the same admission guard; we MUST NOT
    // queue behind their lock (that would deadlock terminateAll waiting for
    // the canonical path to finish host-side teardown). We fast-path skip them
    // in both passes.
    //
    // Sweeps repeat until either no active loops remain OR every remaining
    // active loop is already admitted by a canonical `terminateLoop` call
    // (so they will record their own row and persist their own cancellation
    // without our help). Re-sweeping catches snapshot-timing gaps: a loop
    // activated (e.g. by a concurrent restart) while an earlier sweep was
    // awaiting a contended lock is observed fresh in the next sweep and gets
    // exactly one ordered shutdown row. The previous implementation fell back
    // to a raw `loopService.terminateAll()` that wrote `cancelled` rows for
    // such gap loops without recording any transition row; this loop replaces
    // that fallback with the same locked, guarded record+terminate path. The
    // sweep cap bounds a misbehaving caller that keeps starting loops during
    // shutdown, but in practice shutdown produces 1-2 sweeps then quiesces.
    const MAX_SWEEPS = 8
    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
      const active = loopService.listActive()
      // Skip canonical-admitted loops fast; we have nothing to do for them.
      if (active.every((s) => terminatingLoops.has(s.loopName))) break

      const contended: typeof active = []
      for (const state of active) {
        // Fast-path skip already-admitted loops in both passes.
        if (terminatingLoops.has(state.loopName)) {
          logger.debug(`Loop: terminateAll skipping shutdown row for already-terminating loop ${state.loopName}`)
          continue
        }
        // Contended: defer to the locked pass so we serialize behind the
        // in-flight tick's phase-rotation work.
        if (stateLocks.has(state.loopName)) {
          contended.push(state)
          continue
        }
        // Uncontended eager path: synchronously admit, record, and persist.
        terminatingLoops.add(state.loopName)
        const fresh = loopService.getActiveState(state.loopName)
        if (!fresh?.active) {
          logger.debug(`Loop: terminateAll skipping shutdown row for already-terminated loop ${state.loopName}`)
          continue
        }
        recordShutdownTransitionAndPersist(state.loopName, fresh)
        // Persist cancellation inside the eager admission so a tick queued behind
        // (or fired concurrently with) this synchronous body observes the
        // inactive state on its next microtask and short-circuits before
        // rotating the phase (which would commit a phase row after our terminal
        // row). loopService.terminate fires the 'terminate' notify synchronously
        // here so group orchestration learns about the shutdown inline.
      }
      if (contended.length > 0) {
        await Promise.all(contended.map((state) =>
          withStateLock(state.loopName, async () => {
            const fresh = loopService.getActiveState(state.loopName)
            if (!fresh?.active) {
              logger.debug(`Loop: terminateAll skipping shutdown row for already-terminated loop ${state.loopName}`)
              return
            }
            // Re-check under the lock — a canonical terminateLoop may have been
            // admitted between our outer snapshot and lock acquisition.
            if (terminatingLoops.has(state.loopName)) {
              logger.debug(`Loop: terminateAll skipping shutdown row for already-terminating loop ${state.loopName}`)
              return
            }
            terminatingLoops.add(state.loopName)
            recordShutdownTransitionAndPersist(state.loopName, fresh)
          }),
        ))
      }
    }
  }

  /**
   * Record one terminal `shutdown` transition row for the loop and persist the
   * cancellation in place. Used by `terminateAll` for every loop it admits
   * (both eager and contended passes, plus each re-sweep). Centralizing the
   * record+persist pair prevents drift between the snapshot passes and any
   * snapshot-gap re-sweep.
   */
  function recordShutdownTransitionAndPersist(loopName: string, fresh: LoopState): void {
    const shutdownReason: TerminationReason = { kind: 'shutdown' }
    const shutdownStatus = terminationStatusFor(shutdownReason)
    const shutdownReasonText = terminationReasonToString(shutdownReason)
    loopService.recordTransition(loopName, {
      eventType: shutdownReason.kind,
      transitionKind: 'terminate',
      fromPhase: fresh.phase,
      toPhase: null,
      status: shutdownStatus,
      reason: shutdownReasonText,
      iteration: fresh.iteration ?? 0,
      sectionIndex: transitionSectionIndex(fresh),
    })
    loopService.terminate(loopName, {
      status: shutdownStatus,
      reason: shutdownReasonText,
      completedAt: Date.now(),
    })
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
    // Hold the state lock for the duration of terminateLoop so a concurrent
    // phase-rotation tick cannot commit a rotation between the time we observe
    // the loop and the time the terminal row is recorded. The authoritative
    // under-lock state inside terminateLoop then drives the terminal row's
    // fromPhase. See `terminateLoopByName` for the same rationale.
    return await withStateLock(loopName, async () => {
      const state = loopService.getActiveState(loopName)
      if (!state?.active) return false
      await terminateLoop(loopName, state, { kind: 'user_aborted' })
      return true
    })
  }

  async function terminateLoopByName(loopName: string, reason: TerminationReason): Promise<boolean> {
    // Serialize with phase-rotation ticks (which also acquire the state lock).
    // Without this guard, a tick could rotate the phase (and commit its row)
    // between cancel reading the caller's snapshot and terminateLoop recording
    // the terminal row from that stale snapshot. Holding the lock for the
    // duration of terminateLoop guarantees the authoritative under-lock state
    // observed inside terminateLoop is the persisted phase at termination time,
    // so the terminal row's fromPhase matches the persisted phase exactly.
    return await withStateLock(loopName, async () => {
      const state = loopService.getActiveState(loopName)
      if (!state?.active) return false
      await terminateLoop(loopName, state, reason)
      return true
    })
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
    // Retain the old session in the reverse index before restoring state so that
    // delayed errors from the pre-restart session still resolve to this loop.
    const oldState = loopService.getAnyState(name)
    const fromPhase = oldState?.phase ?? params.newState.phase
    // In-place UPDATE preserves child rows (loop_transitions, section_plans)
    // that would be cascade-deleted by the prior deleteState + setState pair.
    // The loop row is restored in place (or inserted if concurrently deleted)
    // so existing transition history survives restart.
    loopService.restoreState(name, params.newState)
    loopService.registerLoopSession(params.newSessionId, name)
    sessionToLoop.set(params.newSessionId, name)
    if (oldState?.sessionId) {
      sessionToLoop.set(oldState.sessionId, name)
    }
    loopRegistry.add(name)
    // Record at most one phase-changing restart row, matching the production
    // restart path in services/execution.ts (eventType 'restart', kind 'phase',
    // skipped when the restart preserves the persisted phase). The previous
    // destructive implementation recorded nothing while erasing prior history
    // via cascade.
    if (fromPhase !== params.newState.phase) {
      loopService.recordTransition(name, {
        eventType: 'restart',
        transitionKind: 'phase',
        fromPhase,
        toPhase: params.newState.phase,
        iteration: params.newState.iteration ?? 0,
        sectionIndex: transitionSectionIndex(params.newState),
      })
    }
  }

  function setPhase(name: string, phase: LoopState['phase']): void {
    // Read the prior phase before persisting so we can record exactly one
    // transition row when the phase actually changes (and none for a no-op).
    // The public setPhase path does not flow through nextTransition, so it must
    // emit its own row to satisfy the "every phase change produces exactly one
    // loop_transitions row" invariant.
    const priorState = loopService.getAnyState(name)
    const fromPhase = priorState?.phase
    loopService.setPhase(name, phase)
    if (priorState && fromPhase && fromPhase !== phase) {
      loopService.recordTransition(name, {
        eventType: 'set-phase',
        transitionKind: 'phase',
        fromPhase,
        toPhase: phase,
        iteration: priorState.iteration ?? 0,
        sectionIndex: transitionSectionIndex(priorState),
      })
    }
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
