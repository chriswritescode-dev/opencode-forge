import type { LoopService } from './service'
import { createLoopService } from './service'
import { generateUniqueName } from './name-uniqueness'
import type { LoopState } from './state'
import { transitionSectionIndex } from './state'
import { createLoopWatchdog, type LoopWatchdogStallInfo, type LoopWatchdogRecoveryContext } from '../hooks/watchdog'
// worktree-completion imports moved to hooks/loop.ts (termination side-effects)
import { loopRegistry } from '../utils/loop-registry'
import { clearPromptPending, isAwaitingBusy, isAwaitingBusyExpired } from './idle-gate'
import { clearPromptInFlightBySession } from './in-flight-guard'
import type { TerminationReason } from './termination'
import { createUsageCapture } from './runtime-usage'
import { createPromptDispatch } from './runtime-prompt'
import { createWorkspaceLifecycle } from './runtime-workspace'
import { createPromptRetry } from './runtime-retry'
import { createSessionLifecycle } from './runtime-sessions'
import { createTermination } from './runtime-termination'
import { classifyProviderLimit } from './provider-limit'

import {
  createRuntimeContext,
  type LoopRuntimeDeps,
  type LoopEvent,
  type StartLoopInput,
  type PhaseRunnerCollaborators,
} from './runtime-context'
import { createTransitionLog } from './runtime-transition-log'
import { createCodingPhase } from './runtime-phase-coding'
import { createAuditPhases } from './runtime-phase-audit'

export type {
  LoopRuntimeDeps,
  LoopEvent,
  OnTerminatedCallback,
  StartLoopInput,
} from './runtime-context'

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

  const ctx = createRuntimeContext(deps)
  const transitionLog = createTransitionLog(ctx)

  function runExclusive<T>(loopName: string, fn: () => Promise<T>): Promise<T> {
    return ctx.withStateLock<T>(loopName, fn)
  }

  // `runExclusive` (the in-loop lock using ctx.withStateLock) is hoisted above and is
  // available to createLoopService below.
  const loopService = ctx.loopService = deps.loopService ?? createLoopService(
    loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger, loopConfig, notify, sectionPlansRepo, loopTransitionsRepo, planAmendmentsRepo, runExclusive,
  )

  const usageCapture = createUsageCapture({ client, logger, getConfig, projectId, loopSessionUsageRepo })
  const promptDispatch = createPromptDispatch({ client, logger, getConfig, loopService })

  const workspaceLifecycle = createWorkspaceLifecycle({ client, logger, loopService })

  const promptRetry = createPromptRetry({ ctx, logger, client, promptDispatch })

  const sessions = createSessionLifecycle({
    ctx,
    logger,
    getConfig,
    client,
    getParentSessionId: deps.getParentSessionId,
    promptDispatch,
    usageCapture,
    workspace: workspaceLifecycle,
    promptRetry,
    transitionLog,
  })

  const termination = createTermination({
    ctx,
    logger,
    client,
    onTerminated,
    transitionLog,
    usageCapture,
  })
  const { terminateLoop, tryTerminateLoop, terminateAll, terminateLoopByName, cancelBySessionId, clearLoopTimers, clearAllRetryTimeouts } = termination
  ctx.terminateLoop = terminateLoop

  const { resolveSessionLoopName, rotateToCodingAfterAuditFailure } = sessions

  async function recoverWatchdogStall(
    loopName: string,
    _state: LoopState,
    context: LoopWatchdogRecoveryContext,
  ): Promise<void> {
    await ctx.withStateLock(loopName, async () => {
      const freshState = loopService.getActiveState(loopName)
      if (!freshState?.active) return

      try {
        await ctx.runPhase(freshState.phase, loopName, freshState)
      } catch (err) {
        await promptRetry.handlePromptError(loopName, freshState, `watchdog recovery in ${freshState.phase} phase (${context.reason})`, err)
      }
    })
  }

  const watchdog = ctx.watchdog = createLoopWatchdog({
    loopService,
    client,
    logger,
    recover: recoverWatchdogStall,
    terminate: tryTerminateLoop,
    resolveSessionLoopName,
  })

  const collab: PhaseRunnerCollaborators = {
    logger,
    client,
    getConfig,
    projectId,
    loopsRepo,
    transitionLog,
    sessions,
    promptRetry,
    promptDispatch,
    workspace: workspaceLifecycle,
    termination: { terminateLoop },
    setPhase,
  }

  const codingPhase = createCodingPhase(ctx, collab)
  const auditPhases = createAuditPhases(ctx, collab, codingPhase)

  // Single source of truth for idle/watchdog dispatch. Every persisted phase maps to
  // exactly one phase runner; new phases must be added here to be reachable.
  const phaseRunners: Record<LoopState['phase'], (loopName: string, state: LoopState) => Promise<void>> = {
    coding: codingPhase.runCodingPhase,
    auditing: auditPhases.runAuditingPhase,
    final_auditing: auditPhases.runFinalAuditPhase,
    final_audit_fix: auditPhases.runFinalAuditFixPhase,
    post_action: auditPhases.runPostActionPhase,
  }
  ctx.runPhase = (phase, loopName, state) => phaseRunners[phase](loopName, state)

  /** Re-fetch the last message; run `onAssistant` if the assistant replied, otherwise `onNoAssistant`. */
  async function resumeOrFallback(
    loopName: string,
    state: LoopState,
    eventSessionId: string,
    onAssistant: (loopName: string, state: LoopState) => Promise<void>,
    onNoAssistant: (loopName: string, state: LoopState) => Promise<void>,
  ): Promise<void> {
    const { lastMessageRole } = await promptDispatch.getLastAssistantInfo(eventSessionId, state.worktreeDir)
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
          await ctx.withStateLock(affectedLoop.loopName, async () => {
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
        await ctx.withStateLock(loopName, async () => {
          const state = loopService.getActiveState(loopName)
          if (!state?.active) return
          const isCurrentSession = state.sessionId === eventSessionId
          if (!isCurrentSession) {
            logger.log(`Loop: ignoring stale aborted event for session ${eventSessionId} (current=${state.sessionId})`)
            return
          }
          if (state.phase === 'auditing') {
            await resumeOrFallback(loopName, state, eventSessionId,
              async (ln, s) => { logger.log(`Loop: audit session ${eventSessionId} aborted after assistant response, processing audit result`); await auditPhases.runAuditingPhase(ln, s) },
              async (ln, s) => { logger.log(`Loop: audit session ${eventSessionId} aborted, cleaning up and rolling back to coding`); await rotateToCodingAfterAuditFailure(ln, s, 'aborted', 'audit-session-aborted') },
            )
            return
          }
          if (state.phase === 'final_auditing') {
            await resumeOrFallback(loopName, state, eventSessionId,
              async (ln, s) => { logger.log(`Loop: final audit session ${eventSessionId} aborted after assistant response, processing audit result`); await auditPhases.runFinalAuditPhase(ln, s) },
              async (ln, s) => { logger.log(`Loop: final audit session ${eventSessionId} aborted, cleaning up and rolling back to coding`); await rotateToCodingAfterAuditFailure(ln, s, 'aborted', 'final-audit-session-aborted') },
            )
            return
          }
          if (state.phase === 'post_action') {
            await resumeOrFallback(loopName, state, eventSessionId,
              async (ln, s) => { logger.log(`Loop: post-action session ${eventSessionId} aborted after assistant response, processing result`); await auditPhases.runPostActionPhase(ln, s) },
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
      await ctx.withStateLock(loopName, async () => {
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
          const { lastMessageRole } = await promptDispatch.getLastAssistantInfo(eventSessionId, state.worktreeDir)
          if (lastMessageRole === 'assistant') {
            logger.log(`Loop: final audit session ${eventSessionId} error after assistant response, processing audit result`)
            await auditPhases.runFinalAuditPhase(loopName, state)
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
      await ctx.withStateLock(loopName, async () => {
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

    await ctx.withStateLock(loopName, async () => {
      const state = loopService.getActiveState(loopName)
      if (!state || !state.active) return

      const isCurrentSession = state.sessionId === sessionId
      if (!isCurrentSession) {
        logger.log(`Loop: ignoring stale idle event for session ${sessionId} (current=${state.sessionId})`)
        return
      }

      try {
        watchdog.start(loopName)

        await ctx.runPhase(state.phase, loopName, state)
      } catch (err) {
        const freshState = loopService.getActiveState(loopName)
        await promptRetry.handlePromptError(loopName, freshState ?? state, `unhandled error in ${(freshState ?? state).phase} phase`, err)
      }
    })
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
    ctx.sessionToLoop.set(state.sessionId, state.loopName)
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
    ctx.sessionToLoop.set(params.newSessionId, name)
    if (oldState?.sessionId) {
      ctx.sessionToLoop.set(oldState.sessionId, name)
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
    ctx.sessionToLoop.set(sessionId, loopName)
  }

  function unregisterSessionReverseIndex(sessionId: string): void {
    ctx.sessionToLoop.delete(sessionId)
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
      sessions.setParentSessionLookup(lookup)
    },
    service: loopService,
  }
}
