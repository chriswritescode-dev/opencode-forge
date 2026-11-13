import type { ForgeClient, ForgeEvent, SessionPromptAsyncParams, SessionStatus } from '../client/port'
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
import type { LoopAttemptsRepo } from '../storage/repos/loop-attempts-repo'
import { activeLoopSessions, createLoopWatchdog, type LoopWatchdogStallInfo, type LoopWatchdogRecoveryContext } from '../hooks/watchdog'
import { resolveLoopModel, resolveLoopAuditorChoice, buildAuditorModelChain, nextAuditorFallbackIndex, isAuditorPhase, usageRoleForPhase, standbyPhaseFor } from '../utils/loop-helpers'
import { parseModelString } from '../utils/model-fallback'
import type { createSandboxManager } from '../sandbox/manager'
import { canonicalizePath } from '../sandbox/path'
import { buildPermissionRulesetForPhase, isCodeGraphEnabled, LOOP_COMPLETE_TOOL_NAME, LOOP_HANDOFF_TOOL_NAME, resolveSessionReuseContextPercent, type LoopPermissionRulesetOptions, type LoopPhaseToolName, type LoopSessionReuseRole } from '../constants/loop'
import { resolveLoopPermissionOptionsForWorkspace } from '../utils/loop-permission-options'
import { createLoopSessionWithWorkspace, deleteSessionBestEffort } from '../utils/loop-session'
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
import {
  attemptCodeGraphReportPath,
  createCodeGraphSnapshotter,
  resolveLoopCodeGraphTarget,
  sectionCodeGraphReportPath,
  type CodeGraphTarget,
} from './code-graph'
import { listSnapshotChangedRanges } from '../utils/audit-snapshot'
import { extractSectionFiles } from '../utils/plan-structure'

import { classifyProviderLimit, extractErrorSignal } from './provider-limit'
import { resolvePostActionConfig } from './post-action-config'
import type { GitService } from '../utils/git-service'
import { commitWorktreeChanges } from '../workspace/worktree-commit'
import { truncateAtWordBoundary } from '../utils/format'
import { buildHandoffNudgePrompt } from './prompts'
import { formatAuditHandoffResult, formatCoderHandoff, formatPostActionReport, formatPostActionSummary, formatSectionSummary, handoffCompletionKey, handoffRoleForPhase, parseHandoffWriteInput, type HandoffArgs, type LoopHandoffRecordFor, type LoopHandoffRole } from './handoff'
import { z, type ZodError } from 'zod'

export interface LoopEvent {
  type: string
  properties?: ForgeEvent['properties']
}

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
  loopService?: LoopService
  gitService?: GitService
  getParentSessionId?: (sessionId: string) => Promise<string | null>
  directory?: string
}

export interface StartLoopInput {
  state: LoopState
}

export type HandoffRecordingResult = { ok: true; replaced: boolean } | { ok: false; error: string }

export interface HandoffRecordingInput {
  sessionId: string
  tool: LoopPhaseToolName
  args: HandoffArgs
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
  snapshotSectionCodeGraph(state: LoopState): Promise<void>
  holdUntilFirstPrompt(state: LoopState): () => void
  startWatchdog(name: string): void
  superviseOwnedLoops(): string[]
  getStallInfo(name: string): LoopWatchdogStallInfo | null
  restart(name: string, params: { newState: LoopState; newSessionId: string }): void
  generateUniqueLoopName(baseName: string, isTaken?: (name: string) => boolean): string
  setPhase(name: string, phase: LoopState['phase']): void
  registerSessionReverseIndex(sessionId: string, loopName: string): void
  unregisterSessionReverseIndex(sessionId: string): void
  setParentSessionLookup(lookup: (sessionId: string) => Promise<string | null>): void
  service: LoopService
  recordHandoff(input: HandoffRecordingInput): Promise<HandoffRecordingResult>
  handleAuditorProviderLimit(loopName: string, limitReason: string, opts?: { eventSessionId?: string; eventType?: 'status' | 'error' }): Promise<boolean>
}

export { isWorkspaceNotFoundError } from './runtime-workspace'

const messagePartUpdatedPropertiesSchema = z.object({
  sessionID: z.string().optional(),
  part: z.object({ sessionID: z.string().optional() }).optional(),
})

const sessionErrorPropertiesSchema = z.looseObject({
  sessionID: z.string().min(1),
  error: z.looseObject({
    name: z.string().optional(),
    data: z.looseObject({
      message: z.string().optional(),
      statusCode: z.number().optional(),
    }).optional(),
  }).optional(),
})

const sessionStatusPropertiesSchema = z.looseObject({
  sessionID: z.string().min(1),
  status: z.looseObject({
    type: z.string().optional(),
    attempt: z.number().optional(),
    message: z.string().optional(),
  }).optional(),
})

const STATE_LOCKS_SHARED_KEY = 'loop-state-locks.v1'
const INTERNAL_FALLBACK_ABORTS_SHARED_KEY = 'loop-internal-fallback-aborts.v1'
const PENDING_CODE_GRAPH_SNAPSHOTS_SHARED_KEY = 'loop-pending-code-graph-snapshots.v1'
const CODE_GRAPH_HEARTBEAT_MS = 20_000

export function __resetLoopRuntimeSharedState(): void {
  processShared(STATE_LOCKS_SHARED_KEY, () => new Map()).clear()
  processShared(INTERNAL_FALLBACK_ABORTS_SHARED_KEY, () => new Map()).clear()
  processShared(PENDING_CODE_GRAPH_SNAPSHOTS_SHARED_KEY, () => new Map()).clear()
}

export function createLoop(deps: LoopRuntimeDeps): Loop {
  const { loopsRepo, plansRepo, reviewFindingsRepo, projectId, client, logger, getConfig, onTerminated, notify, loopConfig, sectionPlansRepo, loopSessionUsageRepo, loopTransitionsRepo, planAmendmentsRepo, gitService } = deps

  const loopService = deps.loopService ?? createLoopService(
    loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger, loopConfig, notify, sectionPlansRepo, loopTransitionsRepo, planAmendmentsRepo, runExclusive, deps.loopAttemptsRepo,
    isCodeGraphEnabled(getConfig()),
  )
  let getParentSessionId = deps.getParentSessionId

  const { getFallbackModelForSession, captureLoopSessionUsage } = createUsageCapture({ client, logger, getConfig, projectId, loopSessionUsageRepo })

  const { sendPromptWithFallback, getLastAssistantInfo } = createPromptDispatch({ client, logger, getConfig, loopService, projectId })

  const retryTimeouts = new Map<string, NodeJS.Timeout>()
  const handoffDeferTimers = new Map<string, NodeJS.Timeout>()
  const handoffNudges = new Map<string, HandoffNudgeState>()

  const stateLocks = processShared(STATE_LOCKS_SHARED_KEY, () => new Map())

  function stateLockKey(loopName: string): string {
    return projectLoopKey(projectId, loopName)
  }

  function commitSectionCheckpoint(state: LoopState, idx: number): void {
    if (!gitService) return
    if (!state.worktree || !state.worktreeDir) return
    const title = loopService.getSectionPlan(state, idx)?.title.trim() ?? ''
    const message = truncateAtWordBoundary(title, 72) || `Section ${idx + 1}`
    const outcome = commitWorktreeChanges(gitService, logger, state.worktreeDir, message)
    if (outcome === 'failed') {
      logger.log(`Loop: section checkpoint commit failed for ${state.loopName ?? 'unknown'}; next section audit will see the accumulated diff`)
    } else if (outcome === 'committed') {
      logger.log(`Loop: committed section checkpoint "${message}" for ${state.loopName ?? 'unknown'}`)
    }
    try {
      const head = gitService.revParseHead(state.worktreeDir)
      const sha = head.ok ? head.stdout.trim() : ''
      if (!sha) {
        logger.log(`Loop: could not record the section checkpoint commit for ${state.loopName ?? 'unknown'}: ${head.stderr.trim() || 'unknown error'}`)
        return
      }
      loopService.setSectionCheckpointCommit(state.loopName, idx, sha)
    } catch (err) {
      logger.log(`Loop: could not record the section checkpoint commit for ${state.loopName ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const instanceDirectory = deps.directory ? canonicalizePath(deps.directory) : null

  function ownsLoopWorktree(worktreeDir: string): boolean {
    if (instanceDirectory === null) return true
    return canonicalizePath(worktreeDir) === instanceDirectory
  }

  function resolveLoopPermissionOptionsForLoop(
    state: Pick<LoopState, 'workspaceId'>,
  ): Promise<LoopPermissionRulesetOptions> {
    return resolveLoopPermissionOptionsForWorkspace(client, getConfig(), state.workspaceId)
  }

  const internalFallbackAborts = processShared(INTERNAL_FALLBACK_ABORTS_SHARED_KEY, () => new Map())

  function consumeInternalFallbackAbort(sessionId: string): boolean {
    const outstanding = internalFallbackAborts.get(sessionId)
    if (outstanding === undefined || outstanding <= 0) return false
    if (outstanding === 1) internalFallbackAborts.delete(sessionId)
    else internalFallbackAborts.set(sessionId, outstanding - 1)
    return true
  }

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

  async function fetchSessionStatuses(directory: string): Promise<SessionStatus | null> {
    const statuses = await client.session.status({ directory })
    return statuses ?? null
  }

  async function findBusyLoopSessions(state: LoopState): Promise<string[]> {
    const statuses = await fetchSessionStatuses(state.worktreeDir)
    if (!statuses) throw new Error('Session status is unavailable')
    const active = await activeLoopSessions(statuses, state.loopName, sessionId => resolveSessionLoopName(sessionId, true))
    return active
      .map(([sessionId]) => sessionId)
      .filter((sessionId) => sessionId !== state.standbySessionId)
  }

  async function findBusyChildSessions(state: LoopState): Promise<string[]> {
    const busy = await findBusyLoopSessions(state)
    return busy.filter((sessionId) => sessionId !== state.sessionId)
  }

  function clearHandoffDeferTimer(loopName: string): void {
    const pending = handoffDeferTimers.get(loopName)
    if (!pending) return
    clearTimeout(pending)
    handoffDeferTimers.delete(loopName)
  }

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

  function reportUnappliedPendingHandoff(loopName: string, sessionId: string, expectedRole: LoopHandoffRole): void {
    const pending = loopService.getPendingHandoff(loopName)
    if (!pending || pending.sessionId !== sessionId || pending.role === expectedRole) return
    logger.error(
      `Loop: pending ${pending.role} handoff for session ${sessionId} in ${loopName} does not match the ${expectedRole} phase; leaving it pending`,
    )
  }

  const { detachFromWorkspace, recoverFromMissingWorkspace, ensureWorkspaceForLoop } = createWorkspaceLifecycle({ client, logger, loopService })

  interface StandbyCandidate {
    sessionId: string
    needsCompaction: boolean
  }

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

  async function inspectReusableStandby(state: LoopState): Promise<StandbyCandidate | null> {
    const standbySessionId = state.standbySessionId
    if (!standbySessionId || standbySessionId === state.sessionId) return null

    if (loopService.hasEscalatedBugFindings(state)) {
      logger.log(`Loop: standby session ${standbySessionId} is not reusable for ${state.loopName}; a bug finding reached the recurrence escalation threshold`)
      return null
    }

    return inspectStandbyCandidate(standbySessionId, state, usageRoleForPhase(standbyPhaseFor(state.phase)))
  }

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

  function replaceLoopSession(
    loopName: string,
    update: Parameters<LoopService['replaceSession']>[1],
  ): void {
    const prior = loopService.getActiveState(loopName)
    loopService.replaceSession(loopName, update)
    if (prior && prior.phase !== update.phase) handoffNudges.delete(loopName)
  }

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

  async function finishLoop(loopName: string, state: LoopState, reason: TerminationReason): Promise<void> {
    await discardStandbySession(loopName, state, 'at loop completion')
    if (reason.kind === 'completed' && await enterPostActionPhase(loopName, state)) {
      return
    }
    await terminateLoop(loopName, state, reason)
  }

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
    sessionToLoop.set(currentState.sessionId, loopName)
    replaceLoopSession(loopName, { newSessionId: created.sessionId, phase: 'post_action' })

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

  function bumpDirtyAuditRecurrence(loopName: string, bugFindings: ReviewFindingRow[]): void {
    loopService.bumpFindingRecurrence(loopName, bugFindings)
  }

  function resetErrorCountIfNeeded(loopName: string, currentState: LoopState, assistantErrorDetected: boolean, phase: string): LoopState {
    if (!assistantErrorDetected && currentState.errorCount && currentState.errorCount > 0) {
      loopService.resetError(loopName)
      loopService.setModelFailed(loopName, false)
      logger.log(`Loop: resetting error count after successful retry in ${phase} phase`)
      return loopService.getActiveState(loopName)!
    }
    return currentState
  }

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
    followUpPrompt: string
    fullPrompt: string
    assistantErrorDetected: boolean
    errorContext: string
    transition: TransitionLogEntry
    discardAuditSession?: boolean
    standby?: StandbyCandidate | null
    resetError?: boolean
    markModelFailed?: boolean
  }

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
    
    if (queue.some(entry => entry.sessionId === sessionId)) return
    
    const role = usageRoleForPhase(phase)
    const fallbackModel = phase && state ? getFallbackModelForSession(state, phase) : undefined
    
    queue.push({ sessionId, role, fallbackModel, directory })
    loopRetainedSessions.set(loopName, queue)
    logger.debug(`Loop: queued session ${sessionId} for retention (loop=${loopName}, context=${context}, queue=${queue.length})`)

    while (queue.length > SESSION_RETENTION) {
      const oldest = queue.shift()!
      logger.log(`Loop: trimming session ${oldest.sessionId} (loop=${loopName}, retention=${SESSION_RETENTION})`)
      
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
    if (terminatingLoops.has(loopName)) {
      logger.debug(`Loop: terminateLoop called for already-terminating loop ${loopName}, skipping`)
      return
    }
    terminatingLoops.add(loopName)

    try {
    const current = loopService.getActiveState(loopName)
    if (!current?.active) {
      logger.debug(`Loop: terminateLoop called for already-terminated loop ${loopName}, skipping`)
      return
    }
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
      for (const entry of retained) {
        if (entry.sessionId === sessionId) continue
        await captureLoopSessionUsage({
          loopName,
          sessionId: entry.sessionId,
          directory: entry.directory,
          role: entry.role,
          fallbackModel: entry.fallbackModel,
        }).catch((cause: unknown) => {
          logger.error(`Loop: failed to capture usage for retained session ${entry.sessionId} on terminate (loop=${loopName})`, cause)
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

    for (const [sid, ln] of sessionToLoop) {
      if (ln === loopName) {
        sessionToLoop.delete(sid)
        internalFallbackAborts.delete(sid)
      }
    }
    internalFallbackAborts.delete(sessionId)
    sessionToLoop.delete(sessionId)

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

    loopService.recordTerminalTransition(loopName, {
      reason,
      fromPhase: state.phase,
      iteration: state.iteration ?? 0,
      sectionIndex: transitionSectionIndex(state),
    })

    try {
      await client.session.abort({ sessionID: sessionId })
    } catch {
    }

    logger.log(`Loop terminated: reason="${terminationReasonToString(reason)}", loop="${state.loopName}", iteration=${state.iteration}`)

    logger.debug(`Loop: terminateLoop reason=${terminationReasonToString(reason)} worktree=${!!state.worktree} logEligible=${reason.kind === 'completed' && !!state.worktree}`)

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

  async function abortForInternalResend(loopName: string, sessionId: string): Promise<void> {
    loopService.discardPendingHandoff(loopName)
    try {
      await client.session.abort({ sessionID: sessionId })
      internalFallbackAborts.set(sessionId, (internalFallbackAborts.get(sessionId) ?? 0) + 1)
    } catch {
    }
    await new Promise((r) => setTimeout(r, AUDITOR_FALLBACK_SETTLE_MS))

    clearPromptPending(projectId, loopName, logger)
    clearPromptInFlight(projectId, loopName)
  }

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
        logger.log(`Loop: auditor fallback already advanced for ${loopName}, skipping re-dispatch`)
        return { kind: 'concurrent' }
      }

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

  async function handleAuditorProviderLimit(
    loopName: string,
    limitReason: string,
    opts?: { eventSessionId?: string; eventType?: 'status' | 'error' },
  ): Promise<boolean> {
    const state = loopService.getActiveState(loopName)
    if (!state?.active || !isAuditorPhase(state.phase)) return false
    if (opts?.eventSessionId && opts.eventSessionId !== state.sessionId) return false

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

  async function handlePromptError(loopName: string, _state: LoopState, context: string, cause: unknown, retryFn?: () => Promise<void>): Promise<void> {
    if (cause instanceof ConcurrentPromptError) {
      logger.log(`Loop: ${context} — rejected as concurrent prompt (prior guard active), skipping retry/termination`)
      return
    }

    const currentState = loopService.getActiveState(loopName)
    if (!currentState?.active) {
      logger.log(`Loop: loop ${loopName} already terminated, ignoring error: ${context}`)
      return
    }

    const signal = extractErrorSignal(cause)
    const limitReason = classifyProviderLimit(signal)
    if (limitReason) {
      if (await handleAuditorProviderLimit(loopName, limitReason)) return
      logger.error(`Loop: ${context} — provider limit detected, terminating without retry`)
      await terminateLoop(loopName, currentState, { kind: 'provider_limit', message: limitReason })
      return
    }

    const nextErrorCount = (currentState.errorCount ?? 0) + 1
    
    if (nextErrorCount < MAX_RETRIES) {
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), will retry`, cause)
      loopService.incrementError(loopName)
      if (retryFn) {
        const retryTimeout = setTimeout(() => {
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
      logger.error(`Loop: ${context} (attempt ${nextErrorCount}/${MAX_RETRIES}), giving up`, cause)
      await terminateLoop(loopName, currentState, { kind: 'error_max_retries', message: context })
    }
  }

  interface PromptRetryOptions {
    loopName: string
    sessionId: string
    agent: 'code' | 'auditor-loop'
    errorContext: string
    isRetryValid?: (fresh: LoopState) => boolean
    send?: (fresh: LoopState) => Promise<void>
    promptText?: string
  }

  function buildPromptRetryFn(opts: PromptRetryOptions): () => Promise<void> {
    const defaultSend = async (freshState: LoopState): Promise<void> => {
      try {
        const params: SessionPromptAsyncParams = {
          sessionID: opts.sessionId,
          directory: freshState.worktreeDir,
          agent: opts.agent,
          parts: [{ type: 'text', text: opts.promptText ?? '' }],
        }
        if (freshState.workspaceId) params.workspace = freshState.workspaceId
        await client.session.promptAsync(params)
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
    errorState: LoopState
    sendErrorContext?: string
    activityTag?: string
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

  const codeGraphSnapshotter = createCodeGraphSnapshotter({ logger })

  const pendingCodeGraphSnapshots = processShared(PENDING_CODE_GRAPH_SNAPSHOTS_SHARED_KEY, () => new Map())

  function codeGraphTransitionToken(state: LoopState): string {
    return `${state.sessionId}|${state.phase}|${state.iteration ?? 0}|${state.currentSectionIndex ?? 0}`
  }

  function isAwaitingCodeGraphSnapshot(state: LoopState): boolean {
    return pendingCodeGraphSnapshots.get(stateLockKey(state.loopName)) === codeGraphTransitionToken(state)
  }

  async function writtenCodeGraphReport(target: CodeGraphTarget, relPath: string, text: string | null): Promise<string | null> {
    if (!text) return null
    return (await codeGraphSnapshotter.writeReport(target, relPath, text)) ? text : null
  }

  interface CodeGraphSnapshotPlan {
    compute(): Promise<string | null>
    record(text: string): void
  }

  function planSectionCodeGraph(state: LoopState): CodeGraphSnapshotPlan | null {
    if (state.totalSections <= 0) return null
    const index = state.currentSectionIndex
    const section = loopService.getSectionPlan(state, index)
    if (!section || section.codeGraph) return null
    const target = resolveLoopCodeGraphTarget(deps.sandboxManager, state, getConfig())
    if (!target) return null
    return {
      compute: async () => {
        const text = await codeGraphSnapshotter.snapshotFiles(target, {
          title: `section ${index + 1}: ${section.title}`,
          files: extractSectionFiles(section.content),
        })
        return writtenCodeGraphReport(target, sectionCodeGraphReportPath(index), text)
      },
      record: (text) => loopService.recordSectionCodeGraph(state, index, text),
    }
  }

  function planAttemptCodeGraph(state: LoopState): CodeGraphSnapshotPlan | null {
    const attempt = loopService.getLatestAttempt(state)
    if (!attempt?.snapshotCommit || attempt.codeGraph) return null
    const snapshotCommit = attempt.snapshotCommit
    const target = resolveLoopCodeGraphTarget(deps.sandboxManager, state, getConfig())
    if (!target) return null
    return {
      compute: async () => {
        const from = attempt.previousCommit ?? `${snapshotCommit}^`
        const changedRanges = await listSnapshotChangedRanges(state.worktreeDir, from, snapshotCommit, logger)
        const files = Object.keys(changedRanges)
        if (files.length === 0) return null
        const text = await codeGraphSnapshotter.snapshotFiles(target, {
          title: `audit attempt ${attempt.attemptNumber} (${attempt.scope})`,
          files,
          changedRanges,
        })
        return writtenCodeGraphReport(target, attemptCodeGraphReportPath(attempt), text)
      },
      record: (text) => loopService.recordAttemptCodeGraph(state, attempt, text),
    }
  }

  function planCodeGraphSnapshot(loopName: string, plan: () => CodeGraphSnapshotPlan | null): CodeGraphSnapshotPlan | null {
    try {
      return plan()
    } catch (err) {
      logger.error(`[code-graph] snapshot planning failed for ${loopName}`, err)
      return null
    }
  }

  async function computeCodeGraphSnapshot(loopName: string, plan: CodeGraphSnapshotPlan): Promise<string | null> {
    const heartbeat = setInterval(
      () => watchdog.recordActivity(loopName, 'code-graph-snapshot'),
      CODE_GRAPH_HEARTBEAT_MS,
    )
    try {
      return await plan.compute()
    } catch (err) {
      logger.error(`[code-graph] snapshot failed for ${loopName}`, err)
      return null
    } finally {
      clearInterval(heartbeat)
      watchdog.recordActivity(loopName, 'code-graph-snapshot')
    }
  }

  function recordCodeGraphSnapshot(loopName: string, plan: CodeGraphSnapshotPlan, text: string | null): void {
    if (!text) return
    try {
      plan.record(text)
    } catch (err) {
      logger.error(`[code-graph] storing the snapshot failed for ${loopName}`, err)
    }
  }

  async function snapshotSectionCodeGraph(state: LoopState): Promise<void> {
    const active = loopService.getActiveState(state.loopName)
    if (active && active.sessionId !== state.sessionId) return
    const plan = planCodeGraphSnapshot(state.loopName, () => planSectionCodeGraph(state))
    if (!plan) return
    recordCodeGraphSnapshot(state.loopName, plan, await computeCodeGraphSnapshot(state.loopName, plan))
  }

  function holdUntilFirstPrompt(state: LoopState): () => void {
    const key = stateLockKey(state.loopName)
    const token = codeGraphTransitionToken(state)
    pendingCodeGraphSnapshots.set(key, token)
    return () => {
      if (pendingCodeGraphSnapshots.get(key) === token) pendingCodeGraphSnapshots.delete(key)
    }
  }

  async function continueAfterCodeGraphSnapshot(
    loopName: string,
    expected: LoopState,
    plan: CodeGraphSnapshotPlan | null,
    resume: (state: LoopState) => Promise<void>,
  ): Promise<void> {
    if (!plan) {
      await resume(expected)
      return
    }
    const key = stateLockKey(loopName)
    const token = codeGraphTransitionToken(expected)
    pendingCodeGraphSnapshots.set(key, token)
    const clearPending = (): void => {
      if (pendingCodeGraphSnapshots.get(key) === token) pendingCodeGraphSnapshots.delete(key)
    }
    void (async () => {
      const text = await computeCodeGraphSnapshot(loopName, plan)
      await withStateLock(loopName, async () => {
        clearPending()
        const fresh = loopService.getActiveState(loopName)
        if (!fresh?.active || codeGraphTransitionToken(fresh) !== token) {
          logger.log(`[code-graph] ${loopName} moved on during the snapshot; dropping the deferred transition`)
          return
        }
        recordCodeGraphSnapshot(loopName, plan, text)
        try {
          await resume(fresh)
        } catch (err) {
          const current = loopService.getActiveState(loopName) ?? fresh
          await handlePromptError(loopName, current, `unhandled error resuming ${current.phase} after a code-graph snapshot`, err)
        }
      })
    })()
      .catch((err) => logger.error(`[code-graph] deferred transition failed for ${loopName}`, err))
      .finally(clearPending)
  }

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

    if (isAwaitingCodeGraphSnapshot(currentState)) {
      logger.log(`Loop: ${loopName} is waiting for a code-graph snapshot or its first prompt, ignoring`)
      return
    }

    if (!currentState.worktreeDir) {
      logger.error(`Loop: loop ${loopName} missing worktreeDir in coding phase, terminating`)
      await terminateLoop(loopName, currentState, { kind: 'missing_worktree_dir' })
      return
    }

    const assistantInfo = await getLastAssistantInfo(currentState.sessionId, currentState.worktreeDir)

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
      if (!await loopService.captureAttempt(currentState, `coding-error:${currentState.sessionId}:${currentState.iteration}`, null)) return
    }

    await continueAfterCodeGraphSnapshot(
      loopName,
      currentState,
      planCodeGraphSnapshot(loopName, () => planAttemptCodeGraph(currentState)),
      (state) => startAuditAfterCoding(loopName, state),
    )
  }

  async function startAuditAfterCoding(loopName: string, coderState: LoopState): Promise<void> {
    let currentState = coderState
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

        const nextSection = loopService.getNextReadySectionPlan(currentState)
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
        const auditedState = currentState
        await continueAfterCodeGraphSnapshot(
          loopName,
          updatedState,
          planCodeGraphSnapshot(loopName, () => planSectionCodeGraph(updatedState)),
          async (sectionState) => {
            await rotateAndSendContinuation(
              loopName,
              auditedState,
              {
                iteration: nextIter,
                currentSectionIndex: nextIdx,
                phase: 'coding',
                lastAuditResult: auditResult,
                auditCount: newAuditCount,
              },
              loopService.buildSectionInitialPrompt(sectionState),
              assistantErrorDetected,
              'section coding continuation',
              {
                eventType: 'auditor-handoff',
                transitionKind: sectionTrans.kind,
                fromPhase: auditedState.phase,
                toPhase: 'coding',
              },
            )
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

  async function completePostAction(
    loopName: string,
    state: LoopState,
    record: LoopHandoffRecordFor<'post_action'> | null,
    reason: TerminationReason,
  ): Promise<void> {
    if (record) loopService.setPostActionReport(loopName, formatPostActionReport(record.payload))
    await terminateLoop(loopName, state, reason, record ? formatPostActionSummary(record.payload) : undefined)
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

  const phaseRunners = {
    coding: runCodingPhase,
    auditing: runAuditingPhase,
    post_action: runPostActionPhase,
  } satisfies Record<LoopState['phase'], (loopName: string, state: LoopState) => Promise<void>>

  async function tick(event: LoopEvent): Promise<void> {
    if (event.type === 'message.part.updated') {
      const properties = messagePartUpdatedPropertiesSchema.safeParse(event.properties)
      if (!properties.success) return
      const sessionId = properties.data.part?.sessionID ?? properties.data.sessionID
      if (sessionId) watchdog.recordSessionContent(sessionId)
      return
    }

    if (event.type === 'session.error') {
      const parsedError = sessionErrorPropertiesSchema.safeParse(event.properties)
      if (!parsedError.success) return
      const errorProps = parsedError.data
      const eventSessionId = errorProps.sessionID
      const errorName = errorProps.error?.name
      const isAbort = errorName === 'MessageAbortedError' || errorName === 'AbortError'

      if (!eventSessionId) return

      if (isAbort) {
        const loopName = loopService.resolveLoopName(eventSessionId)
        if (!loopName) return
        await withStateLock(loopName, async () => {
          const state = loopService.getActiveState(loopName)
          if (!state?.active) return
          if (!ownsLoopWorktree(state.worktreeDir)) {
            logger.log(`Loop: ignoring aborted event for ${loopName}; worktree ${state.worktreeDir} is owned by another instance`)
            return
          }
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

    const parsedStatus = sessionStatusPropertiesSchema.safeParse(event.properties)
    if (!parsedStatus.success) return
    const status = parsedStatus.data.status
    const sessionId = parsedStatus.data.sessionID

    if (status?.type === 'busy') {
      const loopName = loopService.resolveLoopName(sessionId)
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

      if (isAwaitingBusy(projectId, loopName, sessionId)) {
        if (!isAwaitingBusyExpired(projectId, loopName)) {
          logger.debug(`[idle-gate] suppressing queued premature idle loop=${loopName} session=${sessionId} (replacement prompt pending)`)
          consumeInternalFallbackAbort(sessionId)
          return
        }
        logger.log(`[idle-gate] awaiting-busy expired for loop=${loopName} after lock, dispatching idle anyway`)
        clearPromptPending(projectId, loopName, logger)
      }

      internalFallbackAborts.delete(sessionId)
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
    const MAX_SWEEPS = 8
    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
      const active = loopService.listActive()
      if (active.every((s) => terminatingLoops.has(s.loopName))) break

      const contended: typeof active = []
      for (const state of active) {
        if (terminatingLoops.has(state.loopName)) {
          logger.debug(`Loop: terminateAll skipping shutdown row for already-terminating loop ${state.loopName}`)
          continue
        }
        if (stateLocks.has(stateLockKey(state.loopName))) {
          contended.push(state)
          continue
        }
        terminatingLoops.add(state.loopName)
        const fresh = loopService.getActiveState(state.loopName)
        if (!fresh?.active) {
          logger.debug(`Loop: terminateAll skipping shutdown row for already-terminated loop ${state.loopName}`)
          continue
        }
        recordShutdownTransitionAndPersist(state.loopName, fresh)
      }
      if (contended.length > 0) {
        await Promise.all(contended.map((state) =>
          withStateLock(state.loopName, async () => {
            const fresh = loopService.getActiveState(state.loopName)
            if (!fresh?.active) {
              logger.debug(`Loop: terminateAll skipping shutdown row for already-terminated loop ${state.loopName}`)
              return
            }
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
    return await withStateLock(loopName, async () => {
      const state = loopService.getActiveState(loopName)
      if (!state?.active) return false
      await terminateLoop(loopName, state, { kind: 'user_aborted' })
      return true
    })
  }

  async function terminateLoopByName(loopName: string, reason: TerminationReason): Promise<boolean> {
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
      for (const entry of retained) {
        await captureLoopSessionUsage({
          loopName,
          sessionId: entry.sessionId,
          directory: entry.directory,
          role: entry.role,
          fallbackModel: entry.fallbackModel,
        }).catch((cause: unknown) => {
          logger.error(`Loop: failed to capture usage for retained session ${entry.sessionId} on clear (loop=${loopName})`, cause)
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
    const oldState = loopService.getAnyState(name)
    const fromPhase = oldState?.phase ?? params.newState.phase
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
    snapshotSectionCodeGraph,
    holdUntilFirstPrompt,
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
