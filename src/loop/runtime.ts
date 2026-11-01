import type { ForgeClient } from '../client/port'
import type { LoopChangeNotifier, LoopService } from './service'
import { createLoopService, MAX_RETRIES } from './service'
import { generateUniqueName } from './name-uniqueness'
import type { LoopState } from './state'
import { transitionSectionIndex } from './state'
import { isFindingInSectionScope } from './section-scope'
import type { Logger, PluginConfig, LoopConfig } from '../types'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo, ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { LoopTransitionsRepo } from '../storage/repos/loop-transitions-repo'
import type { PlanAmendmentsRepo } from '../storage/repos/plan-amendments-repo'
import type { LoopAttemptsRepo } from '../storage/repos/loop-attempts-repo'
import { activeLoopSessions, createLoopWatchdog, type LoopWatchdogStallInfo, type LoopWatchdogRecoveryContext } from '../hooks/watchdog'
import { resolveLoopModel, resolveLoopAuditorChoice, buildAuditorModelChain, nextAuditorFallbackIndex, isAuditorPhase, usageRoleForPhase, standbyPhaseFor } from '../utils/loop-helpers'
import { parseModelString } from '../utils/model-fallback'
import type { createSandboxManager } from '../sandbox/manager'
import { canonicalizePath } from '../sandbox/path'
// worktree-completion imports moved to hooks/loop.ts (termination side-effects)
import { buildPermissionRulesetForPhase, LOOP_COMPLETE_TOOL_NAME, LOOP_HANDOFF_TOOL_NAME, resolveSessionReuseContextPercent, type LoopPermissionRulesetOptions, type LoopPhaseToolName, type LoopSessionReuseRole } from '../constants/loop'
import { resolveLoopPermissionOptionsForWorkspace } from '../utils/loop-permission-options'
import { createLoopSessionWithWorkspace, deleteSessionBestEffort } from '../utils/loop-session'
// worktree-cleanup imports moved to hooks/loop.ts (termination side-effects)
import { createAuditSession, promptAuditSession } from '../utils/audit-session'
import { formatLoopSessionTitle, formatPostActionSessionTitle } from '../utils/session-titles'
import { clearPromptPending, isAwaitingBusy, isAwaitingBusyExpired, isPromptQueued, recordSuppressedIdle } from './idle-gate'
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
import { processShared, projectLoopKey } from '../utils/process-shared'
import { findSessionAncestor, tolerateUndeterminedParent } from '../utils/session-ancestry'

import { classifyProviderLimit, extractErrorSignal } from './provider-limit'
import { resolvePostActionConfig } from './post-action-config'
import type { GitService } from '../utils/git-service'
import { commitWorktreeChanges } from '../workspace/worktree-commit'
import { buildHandoffNudgePrompt } from './prompts'
import { formatAuditHandoffResult, formatCoderHandoff, formatPostActionReport, formatPostActionSummary, formatSectionSummary, handoffCompletionKey, handoffRoleForPhase, parseHandoffWriteInput, type LoopHandoffRecordFor, type LoopHandoffRole } from './handoff'
import type { ZodError } from 'zod'

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
  loopAttemptsRepo?: LoopAttemptsRepo
  /** Optional injected LoopService (test seam). Defaults to a real one built from the repos. */
  loopService?: LoopService
  /**
   * Git service used for per-section checkpoint commits. Optional: when absent
   * (tests), sections are not checkpointed. Production wiring passes the real
   * service from hooks/loop.ts.
   */
  gitService?: GitService
  /** Optional parent-session lookup for ancestor-aware session→loop resolution (child/subagent support). */
  getParentSessionId?: (sessionId: string) => Promise<string | null>
  /**
   * This plugin instance's own directory. Several plugin instances can share one
   * process, each bound to a different directory, and opencode delivers a session's
   * events only to the instance bound to that session's directory. A loop may
   * therefore be supervised only by the instance whose directory is the loop's
   * worktree; any other instance is blind to its progress. Omitted in tests, which
   * disables the ownership gate.
   */
  directory?: string
}

export interface StartLoopInput {
  state: LoopState
}

export type HandoffRecordingResult = { ok: true; replaced: boolean } | { ok: false; error: string }

export interface HandoffRecordingInput {
  sessionId: string
  tool: LoopPhaseToolName
  args: unknown
  /** The tool call's abort signal; an aborted call never records a handoff. */
  signal?: AbortSignal
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
  /**
   * Starts the watchdog for every active loop whose worktree this instance owns and
   * returns their names. An owning instance can come up after its loop is already
   * running (lazy location boot, server restart, plugin reload) and miss the idle
   * event that would otherwise start supervision, leaving the loop idle forever.
   * No-op when the instance has no directory.
   */
  superviseOwnedLoops(): string[]
  getStallInfo(name: string): LoopWatchdogStallInfo | null
  restart(name: string, params: { newState: LoopState; newSessionId: string }): void
  generateUniqueLoopName(baseName: string, isTaken?: (name: string) => boolean): string
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
  /**
   * Record the current session's phase handoff. Only the loop's current coder, auditor, or
   * post-action session may call it, and only with the role schema for its phase.
   */
  recordHandoff(input: HandoffRecordingInput): Promise<HandoffRecordingResult>
  /**
   * Resolve an auditor provider limit by advancing the fallback chain and
   * re-dispatching the audit prompt, or declining so the caller terminates.
   * Exposed for the restart path, which must invoke it after releasing the
   * per-loop state lock. Returns true when the limit was absorbed.
   */
  handleAuditorProviderLimit(loopName: string, limitReason: string, opts?: { eventSessionId?: string; eventType?: 'status' | 'error' }): Promise<boolean>
}

export { isWorkspaceNotFoundError } from './runtime-workspace'

const STATE_LOCKS_SHARED_KEY = 'loop-state-locks.v1'
const INTERNAL_FALLBACK_ABORTS_SHARED_KEY = 'loop-internal-fallback-aborts.v1'

/**
 * Test-only: clear the process-shared runtime maps between tests. Production code must never
 * call this — clearing a shared map from one disposing instance would break every other live
 * instance that relies on it.
 */
export function __resetLoopRuntimeSharedState(): void {
  processShared<Map<string, Promise<unknown>>>(STATE_LOCKS_SHARED_KEY, () => new Map()).clear()
  processShared<Map<string, number>>(INTERNAL_FALLBACK_ABORTS_SHARED_KEY, () => new Map()).clear()
}

export function createLoop(deps: LoopRuntimeDeps): Loop {
  const { loopsRepo, plansRepo, reviewFindingsRepo, projectId, client, logger, getConfig, onTerminated, notify, loopConfig, sectionPlansRepo, loopSessionUsageRepo, loopTransitionsRepo, planAmendmentsRepo, gitService } = deps

  // `runExclusive` (the in-loop lock using withStateLock) is declared later
  // in this function but is hoisted, so it's always available here.
  const loopService = deps.loopService ?? createLoopService(
    loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger, loopConfig, notify, sectionPlansRepo, loopTransitionsRepo, planAmendmentsRepo, runExclusive, deps.loopAttemptsRepo,
  )
  let getParentSessionId = deps.getParentSessionId

  const { getFallbackModelForSession, captureLoopSessionUsage } = createUsageCapture({ client, logger, getConfig, projectId, loopSessionUsageRepo })

  const { sendPromptWithFallback, getLastAssistantInfo } = createPromptDispatch({ client, logger, getConfig, loopService, projectId })

  const retryTimeouts = new Map<string, NodeJS.Timeout>()
  const handoffDeferTimers = new Map<string, NodeJS.Timeout>()
  /** Handoff nudges sent in the current phase turn (loopName → owner and count). */
  const handoffNudges = new Map<string, HandoffNudgeState>()

  /**
   * Process-wide per-loop state locks. OpenCode loads a separate copy of the plugin module
   * graph for each location, so a loop's state lock must be shared across instances: the host
   * instance can restart a loop under its lock while the worktree instance that owns the loop
   * handles the resulting abort under a different lock, reading pre-restart state and
   * terminating the loop mid-restart. Entries are keyed by project AND loop name because loop
   * names are only unique within a project.
   */
  const stateLocks = processShared<Map<string, Promise<unknown>>>(STATE_LOCKS_SHARED_KEY, () => new Map())

  function stateLockKey(loopName: string): string {
    return projectLoopKey(projectId, loopName)
  }

  /**
   * Commit the just-completed section's work as a `section <N>: <title>`
   * checkpoint so the next section's audit can scope its review to changes
   * made after this commit. Best-effort: failures are logged and never block
   * section advancement — the next audit then simply sees the accumulated diff.
   */
  function commitSectionCheckpoint(state: LoopState, idx: number): void {
    if (!gitService) return
    if (!state.worktree || !state.worktreeDir) return
    const title = loopService.getSectionPlan(state, idx)?.title.trim()
    const message = `section ${idx + 1}: ${title || 'checkpoint'}`
    const outcome = commitWorktreeChanges(gitService, logger, state.worktreeDir, message)
    if (outcome === 'committed') {
      logger.log(`Loop: committed section checkpoint "${message}" for ${state.loopName ?? 'unknown'}`)
    } else if (outcome === 'failed') {
      logger.log(`Loop: section checkpoint commit failed for ${state.loopName ?? 'unknown'}; next section audit will see the accumulated diff`)
    }
  }

  const instanceDirectory = deps.directory ? canonicalizePath(deps.directory) : null

  /**
   * Whether this plugin instance may supervise the loop living in `worktreeDir`.
   * Only the instance bound to that directory receives the loop's session events,
   * so any other instance would be judging progress it cannot observe. Returns
   * true when no directory was supplied, which keeps tests ungated.
   */
  function ownsLoopWorktree(worktreeDir: string): boolean {
    if (instanceDirectory === null) return true
    return canonicalizePath(worktreeDir) === instanceDirectory
  }

  /**
   * Resolves loop permission-ruleset options for the given state's workspace,
   * merging the configured `loop.permissions` rules with any portable rules
   * persisted in the workspace metadata. Delegates to the shared workspace-aware
   * resolver so every loop construction site derives rules through one path.
   */
  function resolveLoopPermissionOptionsForLoop(
    state: Pick<LoopState, 'workspaceId'>,
  ): Promise<LoopPermissionRulesetOptions> {
    return resolveLoopPermissionOptionsForWorkspace(client, getConfig(), state.workspaceId)
  }

  /**
   * Sessions we abort ourselves in `resendAuditPromptWithAuditorModel` to
   * re-dispatch the audit prompt on a fallback model. The value counts how many
   * internal aborts we issued for that session and have not yet consumed. The
   * resulting AbortError events must be consumed (not treated as an audit
   * failure that rotates the loop back to coding). One fallback-chain walk can
   * abort the same reused session more than once, so this is a counter, not a
   * set: every outstanding internal abort gets exactly one matching AbortError
   * consumed, and a genuine abort is only suppressed while a real internal
   * abort is still outstanding. The counter is drained as AbortError events are
   * observed and cleared as a backstop once the replacement prompt completes its
   * lifecycle, so it can never suppress a later genuine abort.
   *
   * Process-wide: the instance that aborts for an internal resend can differ from
   * the instance receiving the resulting AbortError event, so the marker must be
   * visible to both. Session ids are globally unique, so no project key is needed.
   */
  const internalFallbackAborts = processShared<Map<string, number>>(INTERNAL_FALLBACK_ABORTS_SHARED_KEY, () => new Map())

  /**
   * Consume one outstanding internal-abort marker for `sessionId`, mirroring how
   * an AbortError event is consumed in the `session.error` handler. An internal
   * abort terminates either with an AbortError OR with a `session.status: idle`;
   * both are single-consumption terminal events, so both decrement the same
   * counter. Returns true when a marker was consumed.
   */
  function consumeInternalFallbackAbort(sessionId: string): boolean {
    const outstanding = internalFallbackAborts.get(sessionId)
    if (outstanding === undefined || outstanding <= 0) return false
    if (outstanding === 1) internalFallbackAborts.delete(sessionId)
    else internalFallbackAborts.set(sessionId, outstanding - 1)
    return true
  }

  /**
   * Per-loop record of a provider-limit failure we have already absorbed for the
   * current auditor fallback re-dispatch. A single failed prompt can emit more
   * than one limit signal (multiple `session.status: retry` events and/or a
   * terminal `session.error`) before the replacement prompt begins its own
   * lifecycle, and all of them belong to the same failure. While this record is
   * present we absorb every further limit signal for the same session so the
   * chain advances exactly once per failed prompt. The coalescing window closes
   * when the replacement prompt emits `session.status: busy` (which clears this
   * record), so a provider-limit signal from the active replacement prompt is
   * never mistaken for the previous prompt's companion. The record is reset on
   * each committed advance and on the replacement's busy, so it always scopes to
   * the failed prompt's teardown window rather than the session as a whole.
   */
  const coalescedLimitSessions = new Map<string, string>()

  const AUDITOR_FALLBACK_SETTLE_MS = 250
  const MAX_HANDOFF_NUDGES = 3

  interface HandoffNudgeState {
    sessionId: string
    phase: LoopState['phase']
    iteration: number
    count: number
  }

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
    const key = stateLockKey(loopName)
    const prev = stateLocks.get(key) ?? Promise.resolve()
    const nextPromise = prev.catch(() => undefined).then(() => fn())
    stateLocks.set(key, nextPromise)
    void nextPromise.finally(() => {
    if (stateLocks.get(key) === nextPromise) {
      stateLocks.delete(key)
    }
  }).catch(() => undefined)
  return nextPromise
}

  /**
   * Optional metadata passed into shared commit helpers (rotateAndSendContinuation)
   * so the non-terminal transition row is recorded
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
   * `rewind-section` outcomes.
   * `noop` outcomes produce no row.
   *
   * NOTE: callers must invoke this AFTER the corresponding phase persistence
   * (replaceSession / setPhase) succeeds. For paths routed through
   * `rotateAndSendContinuation`, pass the
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
  async function resolveSessionLoopName(sessionId: string, strict = false): Promise<string | null> {
    const direct = loopService.resolveLoopName(sessionId)
    if (direct) return direct

    const fromReverse = sessionToLoop.get(sessionId)
    if (fromReverse) return fromReverse

    if (!getParentSessionId) {
      if (strict) throw new Error('Session ancestry lookup is unavailable')
      return null
    }

    const resolution = findSessionAncestor(sessionId, getParentSessionId, (parentId) => {
      const parentLoop = loopService.resolveLoopName(parentId)
      if (parentLoop) return parentLoop
      return sessionToLoop.get(parentId) ?? null
    })
    return strict ? resolution : tolerateUndeterminedParent(resolution)
  }

  /** Reads the directory's session statuses, or null when the shape is unexpected. */
  async function fetchSessionStatuses(directory: string): Promise<Record<string, { type?: string }> | null> {
    const statuses = await client.session.status({ directory })
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return null
    return statuses
  }

  /**
   * Session ids of every loop session that is busy or retrying, excluding the standby
   * sibling, which is idle by construction until the next rotation reuses it. Throws when
   * the status query fails or ancestry cannot be resolved: callers must never treat an
   * unverifiable status as quiescent.
   */
  async function findBusyLoopSessions(state: LoopState): Promise<string[]> {
    const statuses = await fetchSessionStatuses(state.worktreeDir)
    if (!statuses) throw new Error('Session status is unavailable')
    const active = await activeLoopSessions(statuses, state.loopName, sessionId => resolveSessionLoopName(sessionId, true))
    return active
      .map(([sessionId]) => sessionId)
      .filter((sessionId) => sessionId !== state.standbySessionId)
  }

  /**
   * Busy loop sessions other than the session recording a handoff. That session is the
   * caller and is necessarily busy while the tool runs, so it never counts itself.
   */
  async function findBusyChildSessions(state: LoopState): Promise<string[]> {
    const busy = await findBusyLoopSessions(state)
    return busy.filter((sessionId) => sessionId !== state.sessionId)
  }

  /** Cancels any scheduled handoff deferral re-check for a loop. */
  function clearHandoffDeferTimer(loopName: string): void {
    const pending = handoffDeferTimers.get(loopName)
    if (!pending) return
    clearTimeout(pending)
    handoffDeferTimers.delete(loopName)
  }

  /**
   * Defers a phase handoff indefinitely while any loop session (the current turn's session,
   * its subagents, and the other role's session) is busy or retrying, or a prompt is still
   * queued in the session inbox, re-checking on the existing 1.5s retry timer. Only the
   * standby sibling is exempt. Genuinely wedged sessions are left to the watchdog's
   * progress-aware stall handling rather than a wall-clock cutoff here.
   */
  async function deferWhileLoopSessionsBusy(state: LoopState): Promise<boolean> {
    const loopName = state.loopName
    let reason: string | null = null
    try {
      const busySessions = await findBusyLoopSessions(state)
      if (busySessions.length > 0) reason = `Loop sessions are still busy or retrying: ${busySessions.join(', ')}`
      else if (isPromptQueued(state.sessionId)) reason = 'A prompt is still queued in the session inbox'
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    const fresh = loopService.getActiveState(loopName)
    if (!fresh || fresh.sessionId !== state.sessionId || fresh.phase !== state.phase) return true
    if (!reason) {
      clearHandoffDeferTimer(loopName)
      return false
    }
    logger.debug(`Loop: deferring ${state.phase} handoff for ${loopName}: ${reason}`)
    const pending = handoffDeferTimers.get(loopName)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      handoffDeferTimers.delete(loopName)
      void withStateLock(loopName, async () => {
        const current = loopService.getActiveState(loopName)
        if (!current || current.sessionId !== state.sessionId || current.phase !== state.phase) return
        try {
          await phaseRunners[current.phase](loopName, current)
        } catch (err) {
          await handlePromptError(loopName, current, 'handoff retry failed', err)
        }
      })
    }, 1500)
    handoffDeferTimers.set(loopName, timer)
    return true
  }

  const NOT_CURRENT_SESSION_ERROR = 'Not the current session of an active loop; only the loop\'s current coder, auditor or post-action session may call this tool.'

  function formatHandoffValidationError(error: ZodError): string {
    const details = error.issues.map((issue) => {
      const path = issue.path.join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    return `Invalid handoff payload: ${details.join('; ')}`
  }

  /**
   * Records the current session's handoff under the per-loop state lock. Every check runs
   * before the write so a rejected call leaves no pending row: session ownership, tool/phase
   * pairing, subagent quiescence, the role's strict schema, the audit summary rules, and the
   * tool call's abort signal, which is re-checked right before the write.
   */
  async function recordHandoff(input: HandoffRecordingInput): Promise<HandoffRecordingResult> {
    const active = loopService.resolveActiveLoopForSession(input.sessionId)
    if (!active) return { ok: false, error: NOT_CURRENT_SESSION_ERROR }

    return withStateLock(active.loopName, async () => {
      const state = loopService.resolveActiveLoopForSession(input.sessionId)
      if (!state) return { ok: false, error: NOT_CURRENT_SESSION_ERROR }

      const role = handoffRoleForPhase(state.phase)
      if (!role) return { ok: false, error: `No handoff is accepted while the loop is in phase "${state.phase}".` }
      if (input.tool === LOOP_HANDOFF_TOOL_NAME && role === 'post_action') {
        return { ok: false, error: `In post-action, call ${LOOP_COMPLETE_TOOL_NAME} instead.` }
      }
      if (input.tool === LOOP_COMPLETE_TOOL_NAME && role !== 'post_action') {
        return { ok: false, error: `${LOOP_COMPLETE_TOOL_NAME} is only for the post-action session; call ${LOOP_HANDOFF_TOOL_NAME}.` }
      }

      let busyChildren: string[]
      try {
        busyChildren = await findBusyChildSessions(state)
      } catch (err) {
        return { ok: false, error: `Could not check subagent sessions: ${err instanceof Error ? err.message : String(err)}` }
      }
      if (busyChildren.length > 0) {
        return { ok: false, error: `Wait for these subagent sessions to finish, then call the tool again: ${busyChildren.join(', ')}` }
      }

      const parsed = parseHandoffWriteInput(role, {
        loopName: state.loopName,
        sessionId: input.sessionId,
        phase: state.phase,
        sectionIndex: state.totalSections > 0 ? state.currentSectionIndex : null,
        iteration: state.iteration,
      }, input.args)
      if (!parsed.ok) return { ok: false, error: formatHandoffValidationError(parsed.error) }

      if (parsed.input.role === 'auditor') {
        const payload = parsed.input.payload
        if (state.totalSections > 0) {
          const blocking = loopService.getBlockingBugFindings(state)
          if (blocking.length === 0 && !payload.summary) {
            return { ok: false, error: 'This section has no blocking bug findings, so it is clean: pass summary { done, deviations, followUps }.' }
          }
          if (blocking.length > 0 && payload.summary) {
            const noun = blocking.length === 1 ? 'finding remains' : 'findings remain'
            return { ok: false, error: `${blocking.length} blocking bug ${noun} open; omit summary or resolve them first.` }
          }
        } else if (payload.summary) {
          return { ok: false, error: 'summary applies only to section audits; omit it.' }
        }
      }

      if (input.signal?.aborted) {
        return { ok: false, error: 'The tool call was aborted; no handoff was recorded.' }
      }

      const record = loopService.recordPendingHandoff(parsed.input)
      watchdog.recordActivity(state.loopName, 'handoff-recorded')
      return { ok: true, replaced: record.replaced }
    })
  }

  /**
   * Ends a phase turn that produced no handoff. Re-sends the full phase prompt only when the
   * turn was never answered at all, otherwise sends the short handoff nudge, on the phase's
   * own agent and model. After MAX_HANDOFF_NUDGES the turn is abandoned through the
   * `handoff-missing` transition: coding and auditing error out, post-action stays
   * best-effort and completes.
   */
  async function nudgeForMissingHandoff(
    loopName: string,
    state: LoopState,
    lastMessageRole: string,
    phasePrompt: () => string,
  ): Promise<void> {
    const role = handoffRoleForPhase(state.phase)
    if (!role) return

    const owner = { sessionId: state.sessionId, phase: state.phase, iteration: state.iteration }
    const stored = handoffNudges.get(loopName)
    const nudges = stored
      && stored.sessionId === owner.sessionId
      && stored.phase === owner.phase
      && stored.iteration === owner.iteration
      ? stored.count
      : 0
    if (nudges >= MAX_HANDOFF_NUDGES) {
      logger.error(`Loop: ${state.phase} turn ended without a handoff after ${nudges} nudges for ${loopName}, terminating`)
      const trans = nextTransition(state, { type: 'handoff-missing' })
      if (trans.kind !== 'terminate') return
      await terminateLoop(loopName, state, trans.reason)
      return
    }

    handoffNudges.set(loopName, { ...owner, count: nudges + 1 })
    const unanswered = lastMessageRole === 'none' || lastMessageRole === 'user'
    const promptText = unanswered ? phasePrompt() : buildHandoffNudgePrompt(role)
    logger.log(`Loop: ${state.phase} turn ended without a handoff for ${loopName}; sending ${unanswered ? 'the full phase prompt' : 'a handoff nudge'} (${nudges + 1}/${MAX_HANDOFF_NUDGES})`)

    if (role === 'post_action') {
      const { error } = await sendPostActionPrompt(loopName, state.sessionId, promptText)
      if (error) {
        await handlePromptError(loopName, state, 'failed to send post-action handoff nudge', error)
      }
      return
    }

    const choice = role === 'auditor' ? resolveLoopAuditorChoice(getConfig(), loopService, loopName, logger) : undefined
    await sendPromptWithRetryRecovery({
      loopName,
      sessionId: state.sessionId,
      promptText,
      agent: role === 'auditor' ? 'auditor-loop' : 'code',
      model: choice ? choice.model : resolveLoopModel(getConfig(), loopService, loopName),
      variant: choice ? choice.variant : state.executionVariant,
      errorContext: 'handoff nudge',
      errorState: state,
      isRetryValid: (fresh) => fresh.sessionId === state.sessionId && fresh.phase === state.phase,
    })
  }

  /**
   * Reports a pending handoff that the current phase could not apply because it belongs to
   * another role. The row is left pending for the role that wrote it. A row whose payload no
   * longer parses is reported by the repository's row mapper instead.
   */
  function reportUnappliedPendingHandoff(loopName: string, sessionId: string, expectedRole: LoopHandoffRole): void {
    const pending = loopService.getPendingHandoff(loopName)
    if (!pending || pending.sessionId !== sessionId || pending.role === expectedRole) return
    logger.error(
      `Loop: pending ${pending.role} handoff for session ${sessionId} in ${loopName} does not match the ${expectedRole} phase; leaving it pending`,
    )
  }

  const { detachFromWorkspace, recoverFromMissingWorkspace, ensureWorkspaceForLoop } = createWorkspaceLifecycle({ client, logger, loopService })

  /**
   * A standby session that may carry over into the next phase. `needsCompaction`
   * marks a session whose last turn reached the role's context-reuse threshold:
   * it is still reused, but its context is compacted before the follow-up turn.
   */
  interface StandbyCandidate {
    sessionId: string
    needsCompaction: boolean
  }

  /**
   * Whether a session of `role` can carry over as the next standby: it must
   * still exist, and its role's reuse percentage must not be `0`. A last
   * assistant turn at or above that percentage of the model's context window
   * marks the candidate for compaction instead of rejecting it. An unknown
   * context window (no model on the message, a failed lookup, or no limit)
   * allows reuse without compaction.
   */
  async function inspectStandbyCandidate(
    sessionId: string,
    state: LoopState,
    role: LoopSessionReuseRole,
  ): Promise<StandbyCandidate | null> {
    try {
      const messages = await client.session.messages({ sessionID: sessionId, directory: state.worktreeDir, limit: 4 })
      if (messages.length === 0) {
        logger.log(`Loop: session ${sessionId} (${role}) is not reusable for ${state.loopName}; the session has no messages`)
        return null
      }
      const lastAssistant = [...messages].reverse().find((message) => message.info.role === 'assistant')
      if (!lastAssistant) return { sessionId, needsCompaction: false }

      const maxPercent = resolveSessionReuseContextPercent(getConfig(), role)
      if (maxPercent === 0) {
        logger.log(`Loop: session ${sessionId} (${role}) is not reusable for ${state.loopName}; session reuse is disabled for the ${role} role`)
        return null
      }

      const tokens = lastAssistant.info.tokens
      const contextTokens = tokens ? tokens.input + tokens.cache.read + tokens.cache.write : 0
      const { providerID, modelID } = lastAssistant.info

      let contextLimit: number | undefined
      if (providerID && modelID) {
        try {
          contextLimit = await client.model.contextLimit({ providerID, modelID })
        } catch (err) {
          logger.log(`Loop: context-window lookup failed for ${providerID}/${modelID} (${role} session ${sessionId})`, err)
          contextLimit = undefined
        }
      }

      if (contextLimit === undefined) {
        logger.log(`Loop: reusing session ${sessionId} (${role}) for ${state.loopName}; used ${contextTokens} tokens with an unknown context window for ${providerID ?? 'unknown'}/${modelID ?? 'unknown'}`)
        return { sessionId, needsCompaction: false }
      }

      const contextPercent = (contextTokens / contextLimit) * 100
      if (contextPercent >= maxPercent) {
        logger.log(`Loop: reusing session ${sessionId} (${role}) for ${state.loopName} with compaction; used ${contextTokens} of ${contextLimit} context tokens (${contextPercent.toFixed(1)}%), at or above the ${maxPercent}% reuse threshold`)
        return { sessionId, needsCompaction: true }
      }

      logger.log(`Loop: session ${sessionId} (${role}) is reusable for ${state.loopName}; used ${contextTokens} of ${contextLimit} context tokens (${contextPercent.toFixed(1)}%), below the ${maxPercent}% reuse threshold`)
      return { sessionId, needsCompaction: false }
    } catch (err) {
      logger.log(`Loop: session ${sessionId} (${role}) is not reusable for ${state.loopName}; session lookup failed`, err)
      return null
    }
  }

  /**
   * Compacts a reused standby session before its follow-up turn when its last
   * turn reached the context threshold. Compaction and the follow-up prompt are
   * both queued, so the host runs the compaction first and the prompt lands in
   * the same session. Returns false when the compaction could not be enqueued,
   * so the caller rotates to a fresh session instead of prompting a session
   * whose context would overflow.
   */
  async function compactStandbySession(
    loopName: string,
    state: LoopState,
    standby: StandbyCandidate,
  ): Promise<boolean> {
    if (!standby.needsCompaction) return true
    try {
      await client.session.compact({ sessionID: standby.sessionId, directory: state.worktreeDir })
      logger.log(`Loop: compacting reused session ${standby.sessionId} for ${loopName} before its follow-up turn`)
      return true
    } catch (err) {
      logger.log(`Loop: compaction of reused session ${standby.sessionId} failed for ${loopName}; rotating to a fresh session`, err)
      return false
    }
  }

  /**
   * The single reusability predicate for the recorded standby: it must still
   * exist, its role's reuse percentage must not be `0`, and it must have no
   * blocking bug finding at the recurrence escalation threshold. Standbys only
   * ever hold the other role of the current section (every section change and
   * loop end releases them), so same-section membership holds by construction
   * rather than by a stored field.
   */
  async function inspectReusableStandby(state: LoopState): Promise<StandbyCandidate | null> {
    const standbySessionId = state.standbySessionId
    if (!standbySessionId || standbySessionId === state.sessionId) return null

    if (loopService.hasEscalatedBugFindings(state)) {
      logger.log(`Loop: standby session ${standbySessionId} is not reusable for ${state.loopName}; a bug finding reached the recurrence escalation threshold`)
      return null
    }

    return inspectStandbyCandidate(standbySessionId, state, usageRoleForPhase(standbyPhaseFor(state.phase)))
  }

  /**
   * Shared session-activation bookkeeping for a freshly created session and a
   * reused standby session: clears the old prompt lifecycle and retry timer,
   * registers the new session, keeps the retired session resolvable for delayed
   * errors, starts a fresh handoff nudge budget for the new phase turn, and
   * restarts the watchdog.
   */
  function activateLoopSession(loopName: string, previousSessionId: string | null, newSessionId: string): void {
    clearPromptPending(projectId, loopName, logger)
    const oldRetryTimeout = retryTimeouts.get(loopName)
    if (oldRetryTimeout) {
      clearTimeout(oldRetryTimeout)
      retryTimeouts.delete(loopName)
    }
    clearHandoffDeferTimer(loopName)
    handoffNudges.delete(loopName)
    loopService.registerLoopSession(newSessionId, loopName)
    sessionToLoop.set(newSessionId, loopName)
    if (previousSessionId) sessionToLoop.set(previousSessionId, loopName)
    watchdog.stop(loopName)
    watchdog.start(loopName)
  }

  /**
   * Persists a session/phase replacement and, when the phase changes, starts a fresh
   * handoff nudge budget for the new phase turn. A reused session keeps its conversation,
   * so the previous turn's spent nudges must never shorten the new turn's budget.
   */
  function replaceLoopSession(
    loopName: string,
    update: Parameters<LoopService['replaceSession']>[1],
  ): void {
    const prior = loopService.getActiveState(loopName)
    loopService.replaceSession(loopName, update)
    if (prior && prior.phase !== update.phase) handoffNudges.delete(loopName)
  }

  /**
   * Captures usage for and deletes the loop's recorded standby session, then
   * clears the column. A standby always holds the role opposite the current
   * phase, so its usage is attributed through the opposite phase's role.
   */
  async function discardStandbySession(loopName: string, state: LoopState, context: string): Promise<void> {
    const standbySessionId = state.standbySessionId
    if (!standbySessionId) return
    loopService.setStandbySessionId(loopName, null)
    if (standbySessionId === state.sessionId) return
    const standbyPhase = standbyPhaseFor(state.phase)
    await scheduleSessionDelete({
      loopName,
      sessionId: standbySessionId,
      directory: state.worktreeDir,
      context,
      phase: standbyPhase,
      state,
    })
  }

  /** Re-titles a reused session for the new iteration. Best-effort: a failed title update never blocks the phase switch. */
  async function updateReusedSessionTitle(
    loopName: string,
    sessionId: string,
    state: LoopState,
    context: { iteration: number; currentSectionIndex: number; totalSections: number },
  ): Promise<void> {
    try {
      await client.session.update({
        sessionID: sessionId,
        directory: state.worktreeDir,
        title: formatLoopSessionTitle(loopName, context),
      })
    } catch (err) {
      logger.debug(`Loop: failed to update the title of reused session ${sessionId}`, err)
    }
  }

  /**
   * Rotates to a new session in the same workspace. Creates and binds the new session FIRST,
   * then (unless `options.keepPreviousSession`) fire-and-forget deletes the old session, so the
   * caller can retain it as the standby. This ordering ensures the workspace always has at
   * least one bound session, preventing the host from pruning it from non-focused TUIs.
   */
  async function rotateSession(
    loopName: string,
    state: LoopState,
    titleContext?: { iteration?: number; currentSectionIndex?: number },
    options?: { keepPreviousSession?: boolean },
  ): Promise<string> {
    const oldSessionId = state.sessionId
    const sessionDir = state.worktreeDir

    logger.log(
      `Loop: [perm-diag] rotate loop=${loopName} state.worktree=${String(state.worktree)} state.sandbox=${String(state.sandbox)}`
    )

    const ensured = await ensureWorkspaceForLoop(loopName, state, 'during session rotation')
    const permissionRuleset = buildPermissionRulesetForPhase('coding', await resolveLoopPermissionOptionsForLoop(state))

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

    activateLoopSession(loopName, oldSessionId, newSessionId)

    if (!options?.keepPreviousSession) {
      void scheduleSessionDelete({ loopName, sessionId: oldSessionId, directory: sessionDir, context: 'after session rotation', phase: state.phase, state })
    }

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
    // `null` means the caller must `return` without continuing: the loop was
    // terminated.
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
   * Shared completion tail: enter the configured post-action phase when one is
   * enabled, otherwise terminate the loop with `reason`. Sectioned completion
   * (the last open section audit) and the non-sectioned audit-clear path both
   * finish through here so the post-action/terminate decision has one owner.
   */
  async function finishLoop(loopName: string, state: LoopState, reason: TerminationReason): Promise<void> {
    await discardStandbySession(loopName, state, 'at loop completion')
    if (reason.kind === 'completed' && await enterPostActionPhase(loopName, state)) {
      // The post_action entry row is logged inside enterPostActionPhase (after
      // the persisted phase commit, before the prompt send) so a prompt-send
      // failure cannot insert a terminal row before the phase row.
      return
    }
    await terminateLoop(loopName, state, reason)
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
    await finishLoop(loopName, currentState, trans.reason)
    logger.log(`Loop completed: auditor all-clear at iteration ${currentState.iteration} (audits=${currentState.auditCount ?? 0})`)
    return true
  }

  /**
   * Applies the iteration-cap transition; returns the next iteration or null if terminated.
   * Single source of truth for the maxIterations check so every path routes through
   * `nextTransition({ type: 'iteration-cap' })` instead of inline divergent checks.
   *
   * Callers that need to persist side-effects before terminating (e.g. a path
   * that persists audit metadata) pass an `onTerminate` wrapper; otherwise the
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
    const permission = buildPermissionRulesetForPhase('post_action', await resolveLoopPermissionOptionsForLoop(currentState))
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
    replaceLoopSession(loopName, { newSessionId: created.sessionId, phase: 'post_action' })

    // Record the *entry* into post_action here — after the persisted phase commit
    // AND before sending the post-action prompt. If the prompt send fails below,
    // terminateLoop is invoked from inside this helper and would otherwise insert
    // its terminal row before the entry row, reversing chronological id order.
    // The source event type is the auditor handoff that drove the redirect.
    loopService.recordTransition(loopName, {
      eventType: 'auditor-handoff',
      transitionKind: 'phase',
      fromPhase: currentState.phase,
      toPhase: 'post_action',
      iteration: currentState.iteration ?? 0,
      sectionIndex: transitionSectionIndex(currentState),
    })

    void scheduleSessionDelete({ loopName, sessionId: currentState.sessionId, directory: currentState.worktreeDir, context: 'after post-action creation', phase: currentState.phase, state: currentState })

    const { error } = await sendPostActionPrompt(loopName, created.sessionId, prompt)
    if (error) {
      const targetState = loopService.getActiveState(loopName) ?? currentState
      logger.error(`Loop: failed to send post-action prompt for ${loopName}, completing without action`, error)
      await terminateLoop(loopName, targetState, { kind: 'completed' })
      return true
    }
    watchdog.recordActivity(loopName, 'post-action-prompt-sent')
    return true
  }

  /** Sends a prompt to the post-action session on the configured post-action model, falling back to the loop's auditor model. The auditor model is always sent with the auditor's variant; a configured post-action model has no variant. */
  function sendPostActionPrompt(loopName: string, sessionId: string, promptText: string) {
    const cfg = resolvePostActionConfig(getConfig())
    const auditorChoice = resolveLoopAuditorChoice(getConfig(), loopService, loopName)
    const configuredModel = cfg.model ? parseModelString(cfg.model) : undefined
    return sendPromptWithFallback({
      loopName,
      sessionId,
      promptText,
      agent: 'code',
      model: configuredModel ?? auditorChoice.model,
      fallbackModel: configuredModel ? auditorChoice.model : undefined,
      variant: configuredModel ? undefined : auditorChoice.variant,
      fallbackVariant: configuredModel ? auditorChoice.variant : undefined,
    })
  }

  function bumpDirtyAuditRecurrence(loopName: string, bugFindings: ReviewFindingRow[], sectionIndex?: number): void {
    const findings = sectionIndex === undefined ? bugFindings : bugFindings.filter(f => isFindingInSectionScope(f, sectionIndex))
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
    options?: { keepPreviousSessionAsStandby?: boolean; resetError?: boolean },
  ): Promise<void> {
    let activeSessionId = currentState.sessionId
    try {
      activeSessionId = await rotateSession(loopName, currentState, {
        iteration: stateUpdates.iteration ?? currentState.iteration,
        currentSectionIndex: stateUpdates.currentSectionIndex ?? currentState.currentSectionIndex,
      }, { keepPreviousSession: options?.keepPreviousSessionAsStandby })
    } catch (err) {
      logger.error(`Loop: session rotation failed, continuing with existing session`, err)
    }

    replaceLoopSession(loopName, {
      newSessionId: activeSessionId,
      phase: stateUpdates.phase ?? 'coding',
      iteration: stateUpdates.iteration ?? currentState.iteration,
      resetError: options?.resetError ?? (!assistantErrorDetected && currentState.errorCount > 0),
      auditCount: stateUpdates.auditCount,
      lastAuditResult: stateUpdates.lastAuditResult ?? null,
    })

    if (options?.keepPreviousSessionAsStandby && activeSessionId !== currentState.sessionId) {
      loopService.setStandbySessionId(loopName, currentState.sessionId)
    }

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

  interface CodingSwitchInput {
    loopName: string
    currentState: LoopState
    stateUpdates: Partial<LoopState>
    /** Short findings-only prompt for a reused coder session. */
    followUpPrompt: string
    /** Full continuation prompt used when a fresh coder session is required. */
    fullPrompt: string
    assistantErrorDetected: boolean
    errorContext: string
    transition: TransitionLogEntry
    /** Audit-error / audit-failure paths delete the failed audit session instead of retaining it. */
    discardAuditSession?: boolean
    /** Pre-resolved standby probe for a caller that already inspected it. */
    standby?: StandbyCandidate | null
    /** Overrides the default reset-on-successful-retry decision. */
    resetError?: boolean
    /** Marks the loop's model as failed after the phase commit (audit-failure recovery). */
    markModelFailed?: boolean
  }

  /**
   * Shared dirty-audit → coding switch. Reuses the standby coder session when it
   * is still usable and sends only the findings follow-up; otherwise rotates to a
   * fresh coder session with the full continuation prompt. A reused session that
   * reached its context threshold is compacted first, and a failed compaction
   * falls back to the fresh-session path. The audit session becomes the next
   * standby unless it failed (then it is deleted).
   */
  async function switchToCodingPhase(input: CodingSwitchInput): Promise<void> {
    const { loopName, currentState, stateUpdates, followUpPrompt, fullPrompt, assistantErrorDetected, errorContext, transition } = input
    const auditSessionId = currentState.sessionId
    const candidate = input.standby === undefined ? await inspectReusableStandby(currentState) : input.standby
    const resetError = input.resetError ?? (!assistantErrorDetected && currentState.errorCount > 0)
    let standby = candidate
    if (standby && !await compactStandbySession(loopName, currentState, standby)) standby = null

    if (!standby) {
      await discardStandbySession(loopName, currentState, 'before coder rotation')
      const auditCandidate = input.discardAuditSession || loopService.hasEscalatedBugFindings(currentState)
        ? null
        : await inspectStandbyCandidate(auditSessionId, currentState, 'auditor')
      await rotateAndSendContinuation(
        loopName,
        currentState,
        stateUpdates,
        fullPrompt,
        assistantErrorDetected,
        errorContext,
        transition,
        { keepPreviousSessionAsStandby: auditCandidate !== null, resetError },
      )
      return
    }

    replaceLoopSession(loopName, {
      newSessionId: standby.sessionId,
      phase: stateUpdates.phase ?? 'coding',
      iteration: stateUpdates.iteration ?? currentState.iteration,
      resetError,
      auditCount: stateUpdates.auditCount,
      lastAuditResult: stateUpdates.lastAuditResult ?? null,
    })

    activateLoopSession(loopName, auditSessionId, standby.sessionId)
    recordTransitionEntry(loopName, currentState, transition)
    if (input.markModelFailed) {
      loopService.setModelFailed(loopName, true)
    }

    if (input.discardAuditSession) {
      loopService.setStandbySessionId(loopName, null)
      await scheduleSessionDelete({ loopName, sessionId: auditSessionId, directory: currentState.worktreeDir, context: 'after failed audit', phase: 'auditing', state: currentState })
    } else {
      loopService.setStandbySessionId(loopName, auditSessionId)
    }

    const nextIteration = stateUpdates.iteration ?? currentState.iteration
    logger.log(`Loop: reusing coder session ${standby.sessionId} for ${loopName} (iteration ${nextIteration})`)
    await updateReusedSessionTitle(loopName, standby.sessionId, currentState, {
      iteration: nextIteration ?? 0,
      currentSectionIndex: stateUpdates.currentSectionIndex ?? currentState.currentSectionIndex ?? 0,
      totalSections: currentState.totalSections ?? 0,
    })

    const loopModel = resolveLoopModel(getConfig(), loopService, loopName)
    const { sent, usedModel } = await sendPromptWithRetryRecovery({
      loopName,
      sessionId: standby.sessionId,
      promptText: followUpPrompt,
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
    const standby = await inspectReusableStandby(state)
    const notice = `Auditor session failed: ${reason}. Continuing without new findings.`

    if (standby) {
      await switchToCodingPhase({
        loopName,
        currentState: state,
        stateUpdates: {
          phase: 'coding',
          iteration: state.iteration,
          lastAuditResult: state.lastAuditResult || undefined,
        },
        followUpPrompt: loopService.buildCoderFollowUpPrompt({ ...state, iteration: state.iteration ?? 0 }, undefined, notice),
        fullPrompt: loopService.buildContinuationPrompt({ ...state, iteration: state.iteration ?? 0 }, notice),
        assistantErrorDetected: true,
        errorContext: 'audit failure continuation',
        resetError: false,
        markModelFailed: /provider|auth|model|api\s*error/i.test(reason),
        discardAuditSession: true,
        standby,
        transition: {
          eventType,
          transitionKind: 'error-recovery',
          fromPhase: state.phase,
          toPhase: 'coding',
        },
      })
      return
    }

    await discardStandbySession(loopName, state, 'before coder rotation')
    const newSessionId = await rotateSession(loopName, state)

    replaceLoopSession(loopName, {
      newSessionId,
      phase: 'coding',
      resetError: false,
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
      `Auditor session failed: ${reason}. Continuing without new findings.`,
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
    if (state.totalSections > 0) {
      // `lastAuditResult` is only a "this section has already been audited"
      // marker here; its text is display-only and never replayed to the coder.
      if (state.lastAuditResult) {
        return loopService.buildSectionContinuationPrompt(state)
      }
      return loopService.buildSectionInitialPrompt(state)
    }
    return loopService.buildContinuationPrompt(state)
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
    const role = usageRoleForPhase(phase)
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
      
      void deleteSessionBestEffort(
        client,
        { sessionID: oldest.sessionId, directory: oldest.directory },
        logger,
        `Loop: failed to delete trimmed session ${oldest.sessionId} (loop=${loopName})`,
      )
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
    // The caller's snapshot can lag phase rotations that happened between the
    // caller observing the state
    // and terminateLoop acquiring the admission guard; using the stale
    // snapshot would record the wrong fromPhase/iteration/section/session.
    state = current

    const sessionId = state.sessionId
    watchdog.stop(loopName)
    loopRegistry.remove(projectId, loopName)

    const retryTimeout = retryTimeouts.get(loopName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeouts.delete(loopName)
    }

    clearHandoffDeferTimer(loopName)
    handoffNudges.delete(loopName)
    loopService.discardPendingHandoff(loopName)
    coalescedLimitSessions.delete(loopName)
    clearPromptPending(projectId, loopName, logger)
    clearPromptInFlight(projectId, loopName)

    await discardStandbySession(loopName, state, 'at loop termination')

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
        void deleteSessionBestEffort(
          client,
          { sessionID: entry.sessionId, directory: entry.directory },
          logger,
          `Loop: failed to delete retained session ${entry.sessionId} on terminate (loop=${loopName})`,
        )
      }
      loopRetainedSessions.delete(loopName)
    }

    // Clean up session→loop reverse index for this loop
    for (const [sid, ln] of sessionToLoop) {
      if (ln === loopName) {
        sessionToLoop.delete(sid)
        internalFallbackAborts.delete(sid)
      }
    }
    internalFallbackAborts.delete(sessionId)
    sessionToLoop.delete(sessionId)

    // Capture usage for the final active session before termination
    const fallbackModel = getFallbackModelForSession(state, state.phase)
    const role = usageRoleForPhase(state.phase)
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
    try {
      if (onTerminated) {
        await onTerminated(state, reason)
      }
    } finally {
      notify?.('settled', loopName, { projectDir: state.projectDir, worktreeDir: state.worktreeDir })
    }
    } finally {
      terminatingLoops.delete(loopName)
    }
  }

  /**
   * Abort a session's in-flight message so a replacement prompt can be sent on the
   * SAME session, and mark the abort as internally initiated so the resulting
   * AbortError event is consumed rather than treated as an audit failure or a user
   * abort. The marker is added only once the abort succeeds: a rejected abort
   * (session already idle) emits no AbortError, so leaving a marker would suppress a
   * later genuine abort of the replacement prompt. After settling, the idle-gate and
   * in-flight guard are cleared because they must not reject the resend. Any handoff
   * recorded during the aborted turn belongs to that turn and is discarded so it can
   * never be applied to the re-sent one.
   */
  async function abortForInternalResend(loopName: string, sessionId: string): Promise<void> {
    loopService.discardPendingHandoff(loopName)
    try {
      await client.session.abort({ sessionID: sessionId })
      internalFallbackAborts.set(sessionId, (internalFallbackAborts.get(sessionId) ?? 0) + 1)
    } catch {
      // Session may already be idle.
    }
    await new Promise((r) => setTimeout(r, AUDITOR_FALLBACK_SETTLE_MS))

    clearPromptPending(projectId, loopName, logger)
    clearPromptInFlight(projectId, loopName)
  }

  /**
   * Abort the current audit session (it may be mid-retry when the provider limit
   * arrives via `session.status`), settle, then re-dispatch the audit prompt on the
   * SAME session using the fallback auditor model choice. `createAuditSession`
   * never binds a model, so the existing session accepts a different model on the
   * next prompt without creating a new session.
   */
  async function resendAuditPromptWithAuditorModel(loopName: string, state: LoopState): Promise<{ error?: unknown }> {
    await abortForInternalResend(loopName, state.sessionId)

    const promptText = loopService.buildAuditPrompt(state)
    const choice = resolveLoopAuditorChoice(getConfig(), loopService, loopName, logger)
    const { error } = await sendPromptWithFallback({
      loopName,
      sessionId: state.sessionId,
      promptText,
      agent: 'auditor-loop',
      model: choice.model,
      variant: choice.variant,
    })
    if (!error) {
      watchdog.recordActivity(loopName, 'auditor-model-fallback')
    }
    return { error }
  }

  type AuditorFallbackOutcome =
    | { kind: 'advanced' }
    | { kind: 'concurrent' }
    | { kind: 'exhausted' }
    | { kind: 'failed' }

  async function advanceAuditorFallback(
    loopName: string,
    state: LoopState,
    reason: string,
  ): Promise<AuditorFallbackOutcome> {
    const chain = buildAuditorModelChain(getConfig(), state)
    let from = state.auditorFallbackIndex ?? 0
    let current: LoopState = state
    while (true) {
      const next = nextAuditorFallbackIndex(chain, from)
      if (next === null) {
        logger.error(`Loop: auditor fallback chain exhausted for ${loopName} (${reason})`)
        return { kind: 'exhausted' }
      }

      const committed = loopService.advanceAuditorFallbackIndex(loopName, from, next)
      if (committed === null) {
        // Another detection path already advanced; never double-prompt.
        logger.log(`Loop: auditor fallback already advanced for ${loopName}, skipping re-dispatch`)
        return { kind: 'concurrent' }
      }

      // Record this session as coalesced so companion signals for the same
      // failed prompt are absorbed above rather than advancing again.
      coalescedLimitSessions.set(loopName, state.sessionId)

      current = { ...current, auditorFallbackIndex: committed }
      if (!current.active || !isAuditorPhase(current.phase)) return { kind: 'concurrent' }

      logger.log(`Loop: auditor fallback for ${loopName} (${reason}) → auditor fallback #${committed}`)

      const { error } = await resendAuditPromptWithAuditorModel(loopName, current)
      if (!error) return { kind: 'advanced' }
      if (error instanceof ConcurrentPromptError) return { kind: 'concurrent' }

      if (classifyProviderLimit(extractErrorSignal(error)) !== null) {
        const rechecked = loopService.getActiveState(loopName)
        if (!rechecked?.active) return { kind: 'concurrent' }
        current = rechecked
        from = next
        continue
      }

      logger.error(`Loop: auditor fallback re-dispatch failed for ${loopName}`, error)
      return { kind: 'failed' }
    }
  }

  /**
   * Single choke point for "auditor provider limit → fallback or terminate".
   * Returns `true` when the limit was absorbed (caller must `return` without
   * terminating), `false` when the caller must terminate exactly as today.
   */
  async function handleAuditorProviderLimit(
    loopName: string,
    limitReason: string,
    opts?: { eventSessionId?: string; eventType?: 'status' | 'error' },
  ): Promise<boolean> {
    const state = loopService.getActiveState(loopName)
    if (!state?.active || !isAuditorPhase(state.phase)) return false
    if (opts?.eventSessionId && opts.eventSessionId !== state.sessionId) return false

    // A single failed prompt can emit multiple limit signals (one or more
    // `session.status: retry` events and/or a terminal `session.error`) before
    // the replacement prompt begins its own lifecycle. All of them belong to
    // the same failure, so while the coalescing window is open for this session
    // we absorb every further limit signal (status or error) and the chain
    // advances exactly once per failed prompt. The window closes when the
    // replacement emits `session.status: busy` (clearing `coalescedLimitSessions`),
    // so a genuine limit from the active replacement prompt always advances or
    // exhausts the chain. Prompt-send failures (no event type) are also genuine.
    if (opts?.eventType === 'error' || opts?.eventType === 'status') {
      if (coalescedLimitSessions.get(loopName) === state.sessionId) {
        logger.log(`Loop: coalescing duplicate auditor provider limit for ${loopName} (${limitReason})`)
        return true
      }
    }

    const outcome = await advanceAuditorFallback(loopName, state, limitReason)
    if (outcome.kind === 'exhausted' || outcome.kind === 'failed') return false
    return true
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
      if (await handleAuditorProviderLimit(loopName, limitReason)) return
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
        await withInFlightGuard(projectId, opts.loopName, opts.sessionId, opts.agent, logger, () => send(freshState))
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
   * Recovery for a session wedged in `busy` with no tool activity: abort the stuck
   * message and continue on the SAME session, preserving its conversation. The abort
   * goes through `abortForInternalResend` so the AbortError is not misread as an audit
   * failure or a user abort.
   */
  async function nudgeStuckSession(
    loopName: string,
    _state: LoopState,
    context: LoopWatchdogRecoveryContext,
  ): Promise<void> {
    await withStateLock(loopName, async () => {
      const fresh = loopService.getActiveState(loopName)
      if (!fresh?.active) return

      logger.error(`Loop: nudging wedged session ${fresh.sessionId} for ${loopName} (phase=${fresh.phase}, busy=${context.elapsedMs}ms, stall #${context.stallCount})`)

      try {
        if (isAuditorPhase(fresh.phase)) {
          const outcome = await advanceAuditorFallback(loopName, fresh, 'busy stall (no progress)')
          if (outcome.kind === 'advanced' || outcome.kind === 'concurrent') return
        }

        await abortForInternalResend(loopName, fresh.sessionId)

        const isAuditor = isAuditorPhase(fresh.phase)
        const choice = isAuditor ? resolveLoopAuditorChoice(getConfig(), loopService, loopName, logger) : undefined
        await sendPromptWithRetryRecovery({
          loopName,
          sessionId: fresh.sessionId,
          promptText: 'Continue where you left off.',
          agent: isAuditor ? 'auditor-loop' : 'code',
          model: choice ? choice.model : resolveLoopModel(getConfig(), loopService, loopName),
          variant: choice ? choice.variant : fresh.executionVariant,
          errorContext: 'busy-stall continue nudge',
          errorState: fresh,
        })
      } catch (err) {
        await handlePromptError(loopName, fresh, 'busy-stall continue nudge', err)
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
    nudge: nudgeStuckSession,
    terminate: tryTerminateLoop,
    handleAuditorProviderLimit: (loopName: string, limitReason: string) =>
      withStateLock(loopName, () => handleAuditorProviderLimit(loopName, limitReason)),
    resolveSessionLoopName,
    isPromptQueued,
  })

  /**
   * Sends an audit prompt, handling workspace re-bind recovery and retry
   * registration. The fresh-audit and standby-reuse paths share this dispatch so
   * both recover identically; `buildPrompt` supplies the text re-sent on a retry.
   */
  async function dispatchAuditPrompt(
    loopName: string,
    state: LoopState,
    sessionId: string,
    buildPrompt: (state: LoopState) => string,
    auditorChoice: { model?: { providerID: string; modelID: string }; variant?: string },
    activityTag: string,
  ): Promise<void> {
    let currentState = state
    const { error: auditPromptErr, usedModel: actualAuditorModel } = await sendPromptWithFallback({
      loopName,
      sessionId,
      promptText: buildPrompt(currentState),
      agent: 'auditor-loop',
      model: auditorChoice.model,
      variant: auditorChoice.variant,
    })

    if (auditPromptErr) {
      let effectiveErr: unknown = auditPromptErr
      if (isWorkspaceNotFoundError(auditPromptErr) && currentState.workspaceId) {
        const recovered = await recoverFromMissingWorkspace(loopName, currentState, sessionId, 'during audit prompt recovery')
        currentState = loopService.getActiveState(loopName) ?? currentState
        if (recovered.recovered || !currentState.workspaceId) {
          const retryChoice = resolveLoopAuditorChoice(getConfig(), loopService, loopName)
          const retryResult = await promptAuditSession(client, {
            sessionId,
            worktreeDir: currentState.worktreeDir,
            workspaceId: currentState.workspaceId,
            prompt: buildPrompt(currentState),
            auditorModel: retryChoice.model,
            auditorVariant: retryChoice.variant,
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
        sessionId,
        agent: 'auditor-loop',
        errorContext: 'failed to send audit prompt',
        send: async (fresh) => {
          const retryChoice = resolveLoopAuditorChoice(getConfig(), loopService, loopName)
          const retryResult = await promptAuditSession(client, {
            sessionId,
            worktreeDir: fresh.worktreeDir,
            workspaceId: fresh.workspaceId,
            prompt: buildPrompt(fresh),
            auditorModel: retryChoice.model,
            auditorVariant: retryChoice.variant,
          })
          if (!retryResult.ok) throw retryResult.error
        },
      })
      await handlePromptError(loopName, { ...currentState, phase: 'auditing' }, 'failed to send audit prompt', effectiveErr, retryFn)
      return
    }
    if (actualAuditorModel) {
      logger.log(`auditor using model: ${actualAuditorModel.providerID}/${actualAuditorModel.modelID} (session ${sessionId})`)
    } else {
      logger.log(`auditor using default model (fallback) (session ${sessionId})`)
    }
    watchdog.recordActivity(loopName, activityTag)
  }

  /**
   * coding → auditing switch onto a reused standby audit session. The coder
   * session becomes the standby, so the next dirty audit can return to it with
   * its exploration intact. A reused audit session that reached its context
   * threshold is compacted before the audit follow-up; when that compaction
   * cannot be enqueued the phase is left untouched and the caller rotates to a
   * fresh audit session, so a session is never prompted past its context window.
   * Returns whether the reused session was activated.
   */
  async function switchToAuditingPhase(
    loopName: string,
    currentState: LoopState,
    standby: StandbyCandidate,
    idleTrans: Transition,
  ): Promise<boolean> {
    if (!await compactStandbySession(loopName, currentState, standby)) return false

    const codeSessionId = currentState.sessionId
    const auditSessionId = standby.sessionId

    replaceLoopSession(loopName, { newSessionId: auditSessionId, phase: 'auditing' })
    activateLoopSession(loopName, codeSessionId, auditSessionId)
    loopService.setStandbySessionId(loopName, codeSessionId)
    logTransition(loopName, currentState, { type: 'coder-handoff' }, idleTrans, 'auditing')

    logger.log(`Loop: reusing audit session ${auditSessionId} for ${loopName}`)
    await updateReusedSessionTitle(loopName, auditSessionId, currentState, {
      iteration: currentState.iteration ?? 0,
      currentSectionIndex: currentState.currentSectionIndex ?? 0,
      totalSections: currentState.totalSections ?? 0,
    })

    const auditorChoice = resolveLoopAuditorChoice(getConfig(), loopService, loopName, logger)
    await dispatchAuditPrompt(
      loopName,
      currentState,
      auditSessionId,
      (state) => loopService.buildAuditFollowUpPrompt(state),
      auditorChoice,
      'audit-reused',
    )
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

    // Classify persisted provider-limit errors before anything else.
    if (assistantInfo.errorSignal) {
      const limitReason = classifyProviderLimit(assistantInfo.errorSignal)
      if (limitReason) {
        logger.error(`Loop: provider limit in persisted coding error for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
        return
      }
    }

    const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantInfo.error, 'coding', assistantInfo.errorSignal)
    if (!errorResult) return
    const assistantErrorDetected = errorResult.assistantErrorDetected
    currentState = errorResult.currentState

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'coding')
    if (await deferWhileLoopSessionsBusy(currentState)) return

    const nudgeState = currentState
    const record = loopService.applyPendingHandoff(loopName, currentState.sessionId, 'coder')
    if (!record) reportUnappliedPendingHandoff(loopName, currentState.sessionId, 'coder')
    if (!record && !assistantErrorDetected) {
      await nudgeForMissingHandoff(loopName, nudgeState, assistantInfo.lastMessageRole, () => buildCodingPromptForCurrentState(nudgeState))
      return
    }

    if (record) {
      handoffNudges.delete(loopName)
      if (!await loopService.captureAttempt(currentState, handoffCompletionKey(record), formatCoderHandoff(record.payload))) return
    } else {
      // An assistant error still rotates to audit so the auditor sees the failure;
      // it carries no coder handoff, so the attempt has no decisions.
      if (!await loopService.captureAttempt(currentState, `coding-error:${currentState.sessionId}:${currentState.iteration}`, null)) return
    }

    const currentConfig = getConfig()
    const auditorChoice = resolveLoopAuditorChoice(currentConfig, loopService, loopName, logger)
    const codeSessionId = currentState.sessionId

    const idleTrans = nextTransition(currentState, { type: 'coder-handoff' })
    if (idleTrans.kind === 'terminate') {
      await terminateLoop(loopName, currentState, idleTrans.reason)
      return
    }
    if (idleTrans.kind !== 'rotate') {
      return
    }

    const standbyAuditSession = await inspectReusableStandby(currentState)
    if (standbyAuditSession && await switchToAuditingPhase(loopName, currentState, standbyAuditSession, idleTrans)) {
      return
    }

    async function createAuditWithRetry(input: {
      loopName: string
      iteration: number
      currentSectionIndex: number
      totalSections: number
      worktreeDir: string
      workspaceId?: string
      auditorModel?: { providerID: string; modelID: string }
      prompt: string
      permissionOptions?: LoopPermissionRulesetOptions
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
      auditorModel: auditorChoice.model,
      prompt: loopService.buildAuditPrompt(currentState),
      permissionOptions: await resolveLoopPermissionOptionsForLoop(currentState),
    })

    if (!created) {
      logger.error(`Loop: audit session creation failed after ${MAX_RETRIES} attempts for ${loopName}, rotating to fresh code session`)
      await discardStandbySession(loopName, currentState, 'after audit creation failure')
      loopService.resetError(loopName)
      try {
        const rotatedSessionId = await rotateSession(loopName, currentState)
        replaceLoopSession(loopName, {
          newSessionId: rotatedSessionId,
          phase: 'coding',
          resetError: false,
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

    await discardStandbySession(loopName, currentState, 'after audit creation')
    const retainCoderAsStandby = !loopService.hasEscalatedBugFindings(currentState)
    replaceLoopSession(loopName, {
      newSessionId: created.auditSessionId,
      phase: 'auditing',
    })
    if (retainCoderAsStandby) {
      loopService.setStandbySessionId(loopName, codeSessionId)
    } else {
      void scheduleSessionDelete({ loopName, sessionId: codeSessionId, directory: currentState.worktreeDir, context: 'after audit creation (escalated finding)', phase: 'coding', state: currentState })
    }
    sessionToLoop.set(codeSessionId, loopName)
    sessionToLoop.set(created.auditSessionId, loopName)

    // Record the coding→auditing rotation derived from the pure transition
    // table.  logTransition (non-terminal-only wrapper) writes the row.
    logTransition(loopName, currentState, { type: 'coder-handoff' }, idleTrans, 'auditing')

    await dispatchAuditPrompt(
      loopName,
      currentState,
      created.auditSessionId,
      (state) => loopService.buildAuditPrompt(state),
      auditorChoice,
      'audit-created',
    )
  }

  /**
   * A clean section audit must carry a summary, so a pending auditor record that would
   * finish a section without one is discarded before it is applied: the auditor can record
   * a dirty handoff and then resolve its last blocking bug in the same turn, which leaves a
   * summary-less record behind. Discarding it lets the turn take the missing-handoff path and
   * ask the auditor to hand off again. Returns true when a record was discarded.
   */
  function discardCleanSectionHandoffWithoutSummary(loopName: string, state: LoopState): boolean {
    if (!(state.totalSections > 0)) return false
    const pending = loopService.getPendingHandoff(loopName)
    if (!pending || pending.role !== 'auditor' || pending.sessionId !== state.sessionId) return false
    if (pending.payload.summary) return false
    if (loopService.getBlockingBugFindings(state).length > 0) return false
    loopService.discardPendingHandoff(loopName)
    logger.log(`Loop: section ${state.currentSectionIndex} audit is clean but its handoff carried no summary for ${loopName}; discarding the record and asking the auditor to hand off again`)
    return true
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

    const { error: assistantError, errorSignal: auditErrorSignal, lastMessageRole: auditLastMessageRole } = await getLastAssistantInfo(auditSessionId, currentState.worktreeDir)

    // Classify persisted provider-limit errors first so finish:'error'
    // assistant messages terminate immediately.
    if (auditErrorSignal) {
      const limitReason = classifyProviderLimit(auditErrorSignal)
      if (limitReason) {
        if (await handleAuditorProviderLimit(loopName, limitReason)) return
        logger.error(`Loop: provider limit in persisted auditing error for ${loopName}: ${limitReason}, terminating`)
        await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
        return
      }
    }

    const pendingHandoff = loopService.getPendingHandoff(loopName)
    const auditAbortedWithHandoff = (auditErrorSignal?.name === 'MessageAbortedError' || auditErrorSignal?.name === 'AbortError')
      && pendingHandoff?.sessionId === currentState.sessionId
      && pendingHandoff.role === 'auditor'

    let assistantErrorDetected = false
    if (auditAbortedWithHandoff) {
      logger.log(`Loop: audit session ${auditSessionId} aborted with a pending handoff for ${loopName}, processing the handoff`)
    } else {
      const errorResult = await detectAndHandleAssistantError(loopName, currentState, assistantError, 'auditing', auditErrorSignal)
      if (!errorResult) {
        return
      }
      assistantErrorDetected = errorResult.assistantErrorDetected
      currentState = errorResult.currentState
    }

    currentState = resetErrorCountIfNeeded(loopName, currentState, assistantErrorDetected, 'auditing')

    if (await deferWhileLoopSessionsBusy(currentState)) return

    if (assistantErrorDetected) {
      loopService.discardPendingHandoff(loopName)
      logger.log(`Loop: audit error detected, continuing without incrementing audit count`)
      const nextIteration = await nextIterationOrTerminate(loopName, currentState)
      if (nextIteration === null) return
      const continuationPrompt = loopService.buildContinuationPrompt(
        { ...currentState, iteration: nextIteration },
      )
      const followUpPrompt = loopService.buildCoderFollowUpPrompt({ ...currentState, iteration: nextIteration })
      await switchToCodingPhase({
        loopName,
        currentState,
        stateUpdates: {
          iteration: nextIteration,
          phase: 'coding',
          auditCount: currentState.auditCount ?? 0,
        },
        followUpPrompt,
        fullPrompt: continuationPrompt,
        assistantErrorDetected,
        errorContext: 'coding continuation',
        transition: {
          eventType: 'audit-error',
          transitionKind: 'error-recovery',
          fromPhase: 'auditing',
          toPhase: 'coding',
        },
        discardAuditSession: true,
      })
      return
    }

    const nudgeState = currentState
    if (discardCleanSectionHandoffWithoutSummary(loopName, currentState)) {
      await nudgeForMissingHandoff(loopName, nudgeState, auditLastMessageRole, () => loopService.buildAuditPrompt(nudgeState))
      return
    }
    const record = loopService.applyPendingHandoff(loopName, currentState.sessionId, 'auditor')
    if (!record) {
      reportUnappliedPendingHandoff(loopName, currentState.sessionId, 'auditor')
      await nudgeForMissingHandoff(loopName, nudgeState, auditLastMessageRole, () => loopService.buildAuditPrompt(nudgeState))
      return
    }
    handoffNudges.delete(loopName)

    loopService.resetAuditorFallbackIndex(loopName)
    currentState = { ...currentState, auditorFallbackIndex: 0 }
    const newAuditCount = (currentState.auditCount ?? 0) + 1
    logger.log(`Loop audit ${newAuditCount} at iteration ${currentState.iteration ?? 0}`)

    if (currentState.totalSections > 0) {
      const idx = currentState.currentSectionIndex
      const blockingBugs = loopService.getBlockingBugFindings(currentState)
      const isLastOpen = loopService.isLastOpenSection(currentState)
      const clean = blockingBugs.length === 0
      const auditResult = formatAuditHandoffResult(record.payload, {
        clean,
        blockingBugs: blockingBugs.length,
        sectionIndex: idx,
      })

      if (clean) {
        loopService.finishAttempt(currentState, 'clean')
        logger.log(`Loop: section ${idx} audit clean, marking completed`)

        // Reset recurrence for this section so resolved findings don't falsely escalate later
        loopService.resetSectionRecurrence(loopName, idx)

        loopService.setLastAuditResult(loopName, auditResult)
        loopService.completeSection(loopName, idx, record.payload.summary
          ? formatSectionSummary(record.payload.summary)
          : { done: null, deviations: null, followUps: null })
        commitSectionCheckpoint(currentState, idx)

        let lastOpen = isLastOpen
        const freshRow = loopsRepo.get(projectId, currentState.loopName ?? '')
        if (freshRow && freshRow.totalSections > currentState.totalSections) {
          logger.log(`Loop: amendment appended sections after section ${idx}; no longer the last open section`)
          lastOpen = false
        }

        const sectionEvent: TransitionEvent = { type: 'section-clean', isLastOpenSection: lastOpen }
        const sectionTrans = nextTransition(currentState, sectionEvent)
        if (sectionTrans.kind === 'terminate') {
          logger.log(`Loop: last open section ${idx} audit clean for ${loopName}, completing`)
          await finishLoop(loopName, currentState, sectionTrans.reason)
          return
        }
        if (sectionTrans.kind !== 'advance-section') return

        const nextSection = loopService.getNextIncompleteSectionPlan(currentState)
        const nextIdx = nextSection?.sectionIndex ?? idx + 1
        const nextIter = await nextIterationOrTerminate(loopName, currentState)
        if (nextIter === null) return

        logger.log(`Loop: advancing from section ${idx} to section ${nextIdx}`)
        loopService.setCurrentSectionIndex(loopName, nextIdx)
        loopService.startSection(loopName, nextIdx)

        await discardStandbySession(loopName, currentState, 'after section advance')

        replaceLoopSession(loopName, {
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
            lastAuditResult: auditResult,
            auditCount: newAuditCount,
          },
          continuationPrompt,
          assistantErrorDetected,
          'section coding continuation',
          {
            eventType: 'auditor-handoff',
            transitionKind: sectionTrans.kind,
            fromPhase: currentState.phase,
            toPhase: 'coding',
          },
        )
        return
      }

      const dirtyTrans = nextTransition(currentState, { type: 'section-dirty' })
      if (dirtyTrans.kind !== 'rotate') return

      loopService.finishAttempt(currentState, 'dirty')
      logger.log(`Loop: section ${idx} audit dirty (${blockingBugs.length} blocking bug findings), retrying same section`)

      const nextIter = await nextIterationOrTerminate(loopName, currentState)
      if (nextIter === null) return

      loopService.incrementSectionAttempts(loopName, idx)

      bumpDirtyAuditRecurrence(loopName, blockingBugs)

      loopService.setLastAuditResult(loopName, auditResult)

      const continuationPrompt = loopService.buildSectionContinuationPrompt({ ...currentState, iteration: nextIter }, undefined, blockingBugs)
      const followUpPrompt = loopService.buildCoderFollowUpPrompt({ ...currentState, iteration: nextIter }, blockingBugs)
      await switchToCodingPhase({
        loopName,
        currentState,
        stateUpdates: {
          iteration: nextIter,
          phase: 'coding',
          lastAuditResult: auditResult,
          auditCount: newAuditCount,
        },
        followUpPrompt,
        fullPrompt: continuationPrompt,
        assistantErrorDetected,
        errorContext: 'section retry continuation',
        transition: {
          eventType: 'auditor-handoff',
          transitionKind: dirtyTrans.kind,
          fromPhase: currentState.phase,
          toPhase: 'coding',
        },
      })
      return
    }

    const outstandingBugs = loopService.getOutstandingFindings(loopName, 'bug')
    const auditResult = formatAuditHandoffResult(record.payload, {
      clean: !loopService.hasOutstandingFindings(loopName),
      blockingBugs: outstandingBugs.length,
      sectionIndex: null,
    })
    const candidateState = { ...currentState, auditCount: newAuditCount }
    loopService.finishAttempt(currentState, outstandingBugs.length > 0 ? 'dirty' : 'clean')
    loopService.setLastAuditResult(loopName, auditResult)
    if (await checkAuditClearAndTerminate(loopName, candidateState)) return

    const dirtyTrans = nextTransition(candidateState, { type: 'audit-dirty' })
    if (dirtyTrans.kind !== 'continue') return

    const nextIteration = await nextIterationOrTerminate(loopName, currentState)
    if (nextIteration === null) return

    bumpDirtyAuditRecurrence(loopName, outstandingBugs)

    const continuationPrompt = loopService.buildContinuationPrompt(
      { ...currentState, iteration: nextIteration },
      undefined,
      outstandingBugs,
    )
    const followUpPrompt = loopService.buildCoderFollowUpPrompt({ ...currentState, iteration: nextIteration }, outstandingBugs)

    await switchToCodingPhase({
      loopName,
      currentState,
      stateUpdates: {
        iteration: nextIteration,
        phase: 'coding',
        lastAuditResult: auditResult,
        auditCount: newAuditCount,
      },
      followUpPrompt,
      fullPrompt: continuationPrompt,
      assistantErrorDetected,
      errorContext: 'coding continuation',
      transition: {
        eventType: 'auditor-handoff',
        transitionKind: dirtyTrans.kind,
        fromPhase: candidateState.phase,
        toPhase: 'coding',
      },
    })
  }

  /**
   * Applies the post-action `loop-complete` record, stores its report, and terminates the loop.
   * A null record completes without a report or summary, which is the best-effort outcome of
   * the assistant-error and exhausted-nudge paths.
   */
  async function completePostAction(
    loopName: string,
    state: LoopState,
    record: LoopHandoffRecordFor<'post_action'> | null,
    reason: TerminationReason,
  ): Promise<void> {
    if (record) loopService.setPostActionReport(loopName, formatPostActionReport(record.payload))
    await terminateLoop(loopName, state, reason, record ? formatPostActionSummary(record.payload) : undefined)
  }

  /**
   * Completes the post-action phase once its session is idle. Assistant errors complete
   * best-effort. Otherwise it waits for every loop session, subagents included, to settle,
   * then applies the pending `loop-complete` record and renders the post-action report. A
   * turn without a record is nudged; past MAX_HANDOFF_NUDGES the loop completes best-effort.
   */
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

    const assistantInfo = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)

    if (assistantInfo.error) {
      logger.error(`Loop: post-action assistant error for ${loopName}: ${assistantInfo.error}, completing best-effort`)
      const record = loopService.applyPendingHandoff(loopName, currentState.sessionId, 'post_action')
      if (!record) reportUnappliedPendingHandoff(loopName, currentState.sessionId, 'post_action')
      await completePostAction(loopName, currentState, record, { kind: 'completed' })
      return
    }

    if (await deferWhileLoopSessionsBusy(currentState)) return

    const nudgeState = currentState
    const record = loopService.applyPendingHandoff(loopName, currentState.sessionId, 'post_action')
    if (!record) {
      reportUnappliedPendingHandoff(loopName, currentState.sessionId, 'post_action')
      const cfg = resolvePostActionConfig(getConfig())
      await nudgeForMissingHandoff(loopName, nudgeState, assistantInfo.lastMessageRole, () => loopService.buildPostActionPrompt(nudgeState, { skill: cfg.skill, prompt: cfg.prompt }))
      return
    }
    handoffNudges.delete(loopName)

    logger.log(`Loop: post-action complete for ${loopName}, terminating`)
    const trans = nextTransition(currentState, { type: 'post-action-complete' })
    if (trans.kind !== 'terminate') return
    await completePostAction(loopName, currentState, record, trans.reason)
  }

  // Single source of truth for idle/watchdog dispatch. Every persisted phase maps to
  // exactly one phase runner; new phases must be added here to be reachable.
  const phaseRunners: Record<LoopState['phase'], (loopName: string, state: LoopState) => Promise<void>> = {
    coding: runCodingPhase,
    auditing: runAuditingPhase,
    post_action: runPostActionPhase,
  }

  async function tick(event: LoopEvent): Promise<void> {
    // Streamed content proves the provider stream is alive even while no tool runs,
    // which is the only progress signal a purely-thinking model emits. Fires once per
    // streaming delta, so this stays the first and cheapest branch.
    if (event.type === 'message.part.updated') {
      const part = event.properties?.part as { sessionID?: string } | undefined
      const sessionId = part?.sessionID ?? (event.properties?.sessionID as string | undefined)
      if (sessionId) watchdog.recordSessionContent(sessionId)
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
          // An instance that does not own the worktree never nudges this loop, so it
          // also never holds the internal-abort marker that distinguishes a forge
          // resend from a real user abort. Terminating here would kill a live loop on
          // another instance's abort. Ownership is checked before the marker so the
          // owner still consumes its own aborts normally.
          if (!ownsLoopWorktree(state.worktreeDir)) {
            logger.log(`Loop: ignoring aborted event for ${loopName}; worktree ${state.worktreeDir} is owned by another instance`)
            return
          }
          // Consume an abort we initiated ourselves to re-dispatch the audit
          // prompt on a fallback model. The fallback prompt was already sent on
          // this same session, so its AbortError must not be treated as an audit
          // failure that rotates the loop back to coding. A single fallback-chain
          // walk can abort the same reused session more than once, so this is a
          // counter: each outstanding internal abort consumes exactly one
          // AbortError. Removing the final entry here (and the idle backstop
          // below) means a later genuine abort is never suppressed.
          if (consumeInternalFallbackAbort(eventSessionId)) {
            logger.log(`Loop: consuming internal fallback abort for session ${eventSessionId}`)
            return
          }
          const isCurrentSession = state.sessionId === eventSessionId
          if (!isCurrentSession) {
            logger.log(`Loop: ignoring stale aborted event for session ${eventSessionId} (current=${state.sessionId})`)
            return
          }
          if (state.phase === 'auditing') {
            if (loopService.getPendingHandoff(loopName)?.sessionId === eventSessionId) {
              logger.log(`Loop: audit session ${eventSessionId} aborted with a pending handoff, processing it`)
              await runAuditingPhase(loopName, state)
            } else {
              logger.log(`Loop: audit session ${eventSessionId} aborted without a pending handoff, cleaning up and rolling back to coding`)
              await rotateToCodingAfterAuditFailure(loopName, state, 'aborted', 'audit-session-aborted')
            }
            return
          }
          if (state.phase === 'post_action') {
            if (loopService.getPendingHandoff(loopName)?.sessionId === eventSessionId) {
              logger.log(`Loop: post-action session ${eventSessionId} aborted with a pending handoff, processing it`)
              await runPostActionPhase(loopName, state)
            } else {
              logger.log(`Loop: post-action session ${eventSessionId} aborted without a pending handoff, terminating as completed (best-effort)`)
              await terminateLoop(loopName, state, { kind: 'completed' })
            }
            return
          }
          // coding shares the default abort handling: a coding session aborted by
          // the user terminates the loop as user_aborted.
          logger.log(`Loop: session ${eventSessionId} aborted, terminating loop`)
          await terminateLoop(loopName, state, { kind: 'user_aborted' })
        })
        return
      }

      let loopName: string | null = null
      try {
        loopName = await resolveSessionLoopName(eventSessionId)
      } catch (err) {
        logger.error(`Loop: ancestry lookup failed for error event session=${eventSessionId}, ignoring event`, err)
        return
      }
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
          if (await handleAuditorProviderLimit(loopName, limitReason, { eventSessionId, eventType: 'error' })) return
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
          loopService.discardPendingHandoff(loopName)
          await rotateToCodingAfterAuditFailure(loopName, state, errorMessage, 'audit-session-error')
          return
        }
        const errorMessage = errorProps?.error?.data?.message ?? errorName ?? 'unknown error'
        if (state.phase === 'post_action') {
          if (loopService.getPendingHandoff(loopName)?.sessionId === eventSessionId) {
            logger.log(`Loop: post-action session ${eventSessionId} errored with a pending loop-complete for ${loopName}, completing with its report`)
            await runPostActionPhase(loopName, state)
            return
          }
          logger.error(`Loop: post-action session error for ${eventSessionId}: ${errorMessage}, completing as best-effort`)
          await terminateLoop(loopName, state, { kind: 'completed' })
          return
        }
        // coding keeps the default error handling: surface the error, flag a model
        // failure when applicable, and let the next idle/error event drive recovery.
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
      // The replacement prompt has begun its own lifecycle, so the idle-gate and
      // in-flight markers for this session belong to the freshly dispatched
      // prompt and are cleared. This `busy` also closes the failed prompt's
      // teardown window: a provider-limit `session.error` emitted before it is
      // the failed prompt's terminal companion (absorbed by
      // `coalescedLimitSessions`), whereas any limit signalled after the
      // replacement starts belongs to the replacement and must advance the
      // fallback chain. Clearing the coalesced record here keeps a genuine
      // failure of the active replacement prompt from being mistaken for the
      // previous prompt's companion.
      //
      // The idle-gate pending marker is cleared synchronously (outside the
      // lock) because it only gates a premature `idle` that precedes this
      // `busy`. A fast fallback can emit `busy` then `idle` while the fallback
      // dispatch still holds the state lock; deferring this clear behind the
      // lock would let the following idle observe the still-pending marker at
      // its pre-lock gate and be suppressed, stalling the loop with no phase
      // run. Busy proves the prompt started, so its idle is always legitimate.
      //
      // The in-flight marker is cleared synchronously as well: it is a
      // membership check, not a guard against a queued lifecycle event, so
      // clearing it immediately on this busy is always safe.
      //
      // The state lock is taken only when a coalesced provider-limit marker is
      // present for this exact session. `busy` is the highest-frequency loop
      // event and awaits the shared event pipeline, so we avoid paying the lock
      // on every occurrence. The lock is required only to serialize the
      // coalesced-limit clear against the queued limit handler: duplicate
      // provider-limit signals for the same failed prompt are queued with
      // `withStateLock`, so an unlocked cleanup would clear the guard before
      // the queued handler consumed it, re-advancing the fallback index.
      if (loopName && isAwaitingBusy(projectId, loopName, sessionId)) {
        logger.debug(`[idle-gate] busy observed for ses=${sessionId} loop=${loopName}, clearing pending`)
        clearPromptPending(projectId, loopName, logger)
      }
      if (loopName) {
        const coalesced = coalescedLimitSessions.get(loopName) === sessionId
        clearPromptInFlightBySession(projectId, loopName, sessionId)
        if (coalesced) {
          await withStateLock(loopName, async () => {
            coalescedLimitSessions.delete(loopName)
          })
        }
      }
      return
    }

    if (status?.type === 'retry') {
      let loopName: string | null = null
      try {
        loopName = await resolveSessionLoopName(sessionId)
      } catch (err) {
        logger.error(`Loop: ancestry lookup failed for retry status session=${sessionId}, ignoring event`, err)
        return
      }
      if (!loopName) return
      const limitReason = classifyProviderLimit({ message: status.message })
      if (!limitReason) {
        logger.debug(`Loop: provider retry in progress for ${loopName} (attempt=${status.attempt ?? '?'})`)
        return
      }
      await withStateLock(loopName, async () => {
        const state = loopService.getActiveState(loopName)
        if (!state?.active) return
        if (await handleAuditorProviderLimit(loopName, limitReason, { eventSessionId: sessionId, eventType: 'status' })) return
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

    if (isPromptQueued(sessionId)) {
      recordSuppressedIdle(sessionId)
      logger.debug(`[idle-gate] ignoring idle loop=${loopName} session=${sessionId}; a prompt is still queued in the session inbox`)
      return
    }

    if (isAwaitingBusy(projectId, loopName, sessionId)) {
      if (!isAwaitingBusyExpired(projectId, loopName)) {
        logger.debug(`[idle-gate] suppressing premature idle loop=${loopName} session=${sessionId} (no busy yet)`)
        // This premature idle is the aborted prompt's abort terminal (the
        // internal abort emitted idle instead of an AbortError). Consume its
        // marker so it cannot suppress a later genuine abort of the replacement.
        consumeInternalFallbackAbort(sessionId)
        return
      }
      logger.log(`[idle-gate] awaiting-busy expired for loop=${loopName}, dispatching idle anyway`)
      clearPromptPending(projectId, loopName, logger)
    }

    await withStateLock(loopName, async () => {
      const state = loopService.getActiveState(loopName)
      if (!state || !state.active) return

      if (isPromptQueued(sessionId)) {
        recordSuppressedIdle(sessionId)
        logger.debug(`[idle-gate] ignoring queued idle loop=${loopName} session=${sessionId}; a prompt is still queued in the session inbox`)
        return
      }

      // Re-check the idle gate now that we hold the lock. During a provider-limit
      // fallback, `resendAuditPromptWithAuditorModel` holds the lock while aborting,
      // settling, and re-dispatching. The failed prompt's pending marker was already
      // cleared (by sendLoopPrompt) before the settle delay, so an `idle` emitted by
      // our internal abort can pass the pre-lock check above (line 2463) and queue
      // behind the lock. By the time it runs here, the replacement prompt has been
      // marked pending for this same reused session, so this stale idle must be
      // suppressed against the latest lifecycle rather than running the phase on a
      // session that is busy again.
      if (isAwaitingBusy(projectId, loopName, sessionId)) {
        if (!isAwaitingBusyExpired(projectId, loopName)) {
          logger.debug(`[idle-gate] suppressing queued premature idle loop=${loopName} session=${sessionId} (replacement prompt pending)`)
          // Same as the pre-lock suppression: this stale idle is the failed
          // prompt's abort terminal (idle, not AbortError). Consume the marker
          // so it cannot suppress a later genuine abort of the replacement.
          consumeInternalFallbackAbort(sessionId)
          return
        }
        logger.log(`[idle-gate] awaiting-busy expired for loop=${loopName} after lock, dispatching idle anyway`)
        clearPromptPending(projectId, loopName, logger)
      }

      // The session's prompt has completed its lifecycle. Any internal abort we
      // issued for this session (to re-dispatch the audit on a fallback model)
      // was issued before the replacement prompt, so its AbortError would have
      // arrived by now. Clearing the counter here is the backstop that ensures
      // a stale counter (from an internal abort that produced no event) can
      // never suppress a later genuine abort.
      internalFallbackAborts.delete(sessionId)
      // The failed prompt is definitively done once the replacement completes,
      // so its companion limit signal (if any) has arrived. Clear the coalescing
      // window so a genuine limit from the replacement prompt advances normally
      // even when the original failure emitted no companion signal.
      if (coalescedLimitSessions.get(loopName) === sessionId) {
        coalescedLimitSessions.delete(loopName)
      }

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
        if (stateLocks.has(stateLockKey(state.loopName))) {
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
        // here so the shutdown is observable inline.
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
    void discardStandbySession(loopName, fresh, 'at loop shutdown')
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
    for (const [worktreeName, timeout] of handoffDeferTimers.entries()) {
      clearTimeout(timeout)
      handoffDeferTimers.delete(worktreeName)
    }
    handoffNudges.clear()
    coalescedLimitSessions.clear()
    loopRetainedSessions.clear()
    sessionToLoop.clear()
    terminatingLoops.clear()
    watchdog.clearAll()
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

    clearHandoffDeferTimer(loopName)
    handoffNudges.delete(loopName)
    coalescedLimitSessions.delete(loopName)

    const stateForStandby = loopService.getAnyState(loopName)
    if (stateForStandby) {
      await discardStandbySession(loopName, stateForStandby, 'on loop timer clear')
    }

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
        void deleteSessionBestEffort(
          client,
          { sessionID: entry.sessionId, directory: entry.directory },
          logger,
          `Loop: failed to delete retained session ${entry.sessionId} on clear (loop=${loopName})`,
        )
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
    const state = loopService.getActiveState(name)
    if (state && !ownsLoopWorktree(state.worktreeDir)) {
      logger.log(`Loop: skipping watchdog for ${name}; instance directory ${instanceDirectory} does not own worktree ${state.worktreeDir}`)
      return
    }
    watchdog.start(name)
  }

  /**
   * Starts watchdogs for active loops this instance owns that were started or restarted
   * in this process (registered in the loop registry). Loops persisted before this
   * process are never recovered at boot — plugin init must not resurrect them — while a
   * worktree instance that loads after another instance in the same process started the
   * loop still finds it registered and supervises it.
   */
  function superviseOwnedLoops(): string[] {
    if (instanceDirectory === null) return []
    const owned = listActive().filter(
      (state) =>
        state.worktreeDir &&
        ownsLoopWorktree(state.worktreeDir) &&
        loopRegistry.has(projectId, state.loopName),
    )
    for (const state of owned) {
      logger.log(`Loop: supervising ${state.loopName} owned by instance directory ${instanceDirectory}`)
      watchdog.start(state.loopName)
    }
    return owned.map((state) => state.loopName)
  }

  function getStallInfo(name: string): LoopWatchdogStallInfo | null {
    return watchdog.getStallInfo(name)
  }

  function generateUniqueLoopName(baseName: string, isTaken?: (name: string) => boolean): string {
    const existing = listActive()
      .map(s => s.loopName)
    const recent = listRecent()
      .map(s => s.loopName)
    return generateUniqueName(baseName, [...existing, ...recent], isTaken)
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
    loopRegistry.add(projectId, state.loopName)
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
    if (oldState) {
      void discardStandbySession(name, oldState, 'at loop restart')
    }
    loopRegistry.add(projectId, name)
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
    superviseOwnedLoops,
    getStallInfo,
    restart,
    generateUniqueLoopName,
    setPhase,
    registerSessionReverseIndex,
    unregisterSessionReverseIndex,
    setParentSessionLookup(lookup: (sessionId: string) => Promise<string | null>) {
      getParentSessionId = lookup
    },
    handleAuditorProviderLimit,
    recordHandoff,
    service: loopService,
  }
}
