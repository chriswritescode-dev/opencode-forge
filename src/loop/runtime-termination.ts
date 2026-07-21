import type { RuntimeContext } from './runtime-context'
import type { TransitionLog } from './runtime-transition-log'
import type { UsageCapture } from './runtime-usage'
import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'
import type { LoopState } from './state'
import { transitionSectionIndex } from './state'
import type { TerminationReason } from './termination'
import { terminationStatusFor, terminationReasonToString } from './termination'
import { clearPromptPending, sessionsAwaitingBusy } from './idle-gate'
import { clearPromptInFlight } from './in-flight-guard'
import { loopRegistry } from '../utils/loop-registry'

export interface Termination {
  terminateLoop(loopName: string, state: LoopState, reason: TerminationReason, summary?: string): Promise<void>
  tryTerminateLoop(loopName: string, _state: LoopState, reason: TerminationReason): Promise<void>
  terminateAll(): Promise<void>
  terminateLoopByName(loopName: string, reason: TerminationReason): Promise<boolean>
  cancelBySessionId(sessionId: string): Promise<boolean>
  clearLoopTimers(loopName: string): Promise<void>
  clearAllRetryTimeouts(): void
}

export interface TerminationDeps {
  ctx: RuntimeContext
  logger: Logger
  client: ForgeClient
  onTerminated?: (state: LoopState, reason: TerminationReason) => Promise<void>
  transitionLog: TransitionLog
  usageCapture: UsageCapture
}

export function createTermination(deps: TerminationDeps): Termination {
  const { ctx, logger, client, onTerminated, transitionLog, usageCapture } = deps
  const { getFallbackModelForSession, captureLoopSessionUsage } = usageCapture
  const { recordShutdownTransitionAndPersist } = transitionLog

  async function terminateLoop(loopName: string, state: LoopState, reason: TerminationReason, summary?: string): Promise<void> {
    // Atomic admission guard: only one terminateLoop call per loop can proceed
    // at a time.  Concurrent callers (e.g. user cancel vs. provider-limit
    // detection vs. watchdog) see the flag and skip, preventing double execution
    // of usage capture, abort, persistence, and host teardown.
    if (ctx.terminatingLoops.has(loopName)) {
      logger.debug(`Loop: terminateLoop called for already-terminating loop ${loopName}, skipping`)
      return
    }
    ctx.terminatingLoops.add(loopName)

    try {
    // Idempotency guard: if the loop was already terminated by a concurrent
    // path (e.g. watchdog vs. runtime event), skip duplicate side effects.
    const current = ctx.loopService.getActiveState(loopName)
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
    ctx.watchdog.stop(loopName)
    loopRegistry.remove(loopName)

    const retryTimeout = ctx.retryTimeouts.get(loopName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      ctx.retryTimeouts.delete(loopName)
    }

    const idleRetryTimeout = ctx.idleRetryTimeouts.get(loopName)
    if (idleRetryTimeout) {
      clearTimeout(idleRetryTimeout)
      ctx.idleRetryTimeouts.delete(loopName)
    }
    ctx.idleRetryAttempts.delete(loopName)
    ctx.codingLaunchRecoveryAttempts.delete(loopName)
    clearPromptPending(loopName, logger)
    clearPromptInFlight(loopName)

    const retained = ctx.loopRetainedSessions.get(loopName)
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
      ctx.loopRetainedSessions.delete(loopName)
    }

    // Clean up session→loop reverse index for this loop
    for (const [sid, ln] of ctx.sessionToLoop) {
      if (ln === loopName) ctx.sessionToLoop.delete(sid)
    }
    ctx.sessionToLoop.delete(sessionId)

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
    ctx.loopService.terminate(loopName, {
      status: terminationStatusFor(reason),
      reason: terminationReasonToString(reason),
      completedAt: now,
      summary,
    })

    // Record the terminal transition. This sits inside the `ctx.terminatingLoops`
    // admission guard above so concurrent terminate attempts produce at most one
    // row. Captures every bypass path (cancel/stall/provider-limit/watchdog/
    // missing-worktree) that never flows through `nextTransition`.
    ctx.loopService.recordTerminalTransition(loopName, {
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
      ctx.terminatingLoops.delete(loopName)
    }
  }

  async function tryTerminateLoop(loopName: string, _state: LoopState, reason: TerminationReason): Promise<void> {
    await ctx.withStateLock(loopName, async () => {
      const fresh = ctx.loopService.getActiveState(loopName)
      if (!fresh?.active) return
      await terminateLoop(loopName, fresh, reason)
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
    // 1. Eager synchronous pass for uncontended loops (no entry in `ctx.stateLocks`
    //    means no in-flight tick holds the lock for that loop): admit into
    //    `ctx.terminatingLoops`, re-read authoritative state, record the shutdown
    //    row, and persist the cancellation synchronously. This fires the
    //    'terminate' notify inline so callers/tests that synchronously inspect
    //    notify state see the result without awaiting (parity with the prior
    //    bulk-cancel semantics). JS is single-threaded, so even if a tick
    //    fires concurrently during this synchronous body, its lock acquisition
    //    is microtask-scheduled and cannot interleave our synchronous work.
    //
    // 2. Deferred locked pass for contended loops (`ctx.stateLocks.has(name)` is
    //    true, meaning an in-flight tick already holds/queued the lock): we
    //    queue behind that lock with `ctx.withStateLock`. When the tick finishes
    //    (potentially recording a rotate row), our queued body acquires the
    //    lock, re-reads authoritative state, and records the shutdown row with
    //    the correct post-rotation phase. Ids are guaranteed in chronological
    //    order because the rotate row is recorded while the tick holds the
    //    lock and our shutdown row is recorded only after the tick releases.
    //
    // Loops already admitted by a canonical `terminateLoop` call (present in
    // `ctx.terminatingLoops`) have an in-flight canonical termination that will
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
      const active = ctx.loopService.listActive()
      // Skip canonical-admitted loops fast; we have nothing to do for them.
      if (active.every((s) => ctx.terminatingLoops.has(s.loopName))) break

      const contended: typeof active = []
      for (const state of active) {
        // Fast-path skip already-admitted loops in both passes.
        if (ctx.terminatingLoops.has(state.loopName)) {
          logger.debug(`Loop: terminateAll skipping shutdown row for already-terminating loop ${state.loopName}`)
          continue
        }
        // Contended: defer to the locked pass so we serialize behind the
        // in-flight tick's phase-rotation work.
        if (ctx.stateLocks.has(state.loopName)) {
          contended.push(state)
          continue
        }
        // Uncontended eager path: synchronously admit, record, and persist.
        ctx.terminatingLoops.add(state.loopName)
        const fresh = ctx.loopService.getActiveState(state.loopName)
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
          ctx.withStateLock(state.loopName, async () => {
            const fresh = ctx.loopService.getActiveState(state.loopName)
            if (!fresh?.active) {
              logger.debug(`Loop: terminateAll skipping shutdown row for already-terminated loop ${state.loopName}`)
              return
            }
            // Re-check under the lock — a canonical terminateLoop may have been
            // admitted between our outer snapshot and lock acquisition.
            if (ctx.terminatingLoops.has(state.loopName)) {
              logger.debug(`Loop: terminateAll skipping shutdown row for already-terminating loop ${state.loopName}`)
              return
            }
            ctx.terminatingLoops.add(state.loopName)
            recordShutdownTransitionAndPersist(state.loopName, fresh)
          }),
        ))
      }
    }
  }

  function clearAllRetryTimeouts(): void {
    for (const [worktreeName, timeout] of ctx.retryTimeouts.entries()) {
      clearTimeout(timeout)
      ctx.retryTimeouts.delete(worktreeName)
    }
    for (const [worktreeName, timeout] of ctx.idleRetryTimeouts.entries()) {
      clearTimeout(timeout)
      ctx.idleRetryTimeouts.delete(worktreeName)
    }
    ctx.idleRetryAttempts.clear()
    ctx.codingLaunchRecoveryAttempts.clear()
    ctx.loopRetainedSessions.clear()
    ctx.sessionToLoop.clear()
    ctx.terminatingLoops.clear()
    ctx.watchdog.clearAll()
    ctx.stateLocks.clear()
    sessionsAwaitingBusy.clear()
    logger.log('Loop: cleared all retry timeouts')
  }

  async function cancelBySessionId(sessionId: string): Promise<boolean> {
    const loopName = ctx.loopService.resolveLoopName(sessionId)
    if (!loopName) return false
    // Hold the state lock for the duration of terminateLoop so a concurrent
    // phase-rotation tick cannot commit a rotation between the time we observe
    // the loop and the time the terminal row is recorded. The authoritative
    // under-lock state inside terminateLoop then drives the terminal row's
    // fromPhase. See `terminateLoopByName` for the same rationale.
    return await ctx.withStateLock(loopName, async () => {
      const state = ctx.loopService.getActiveState(loopName)
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
    return await ctx.withStateLock(loopName, async () => {
      const state = ctx.loopService.getActiveState(loopName)
      if (!state?.active) return false
      await terminateLoop(loopName, state, reason)
      return true
    })
  }

  async function clearLoopTimers(loopName: string): Promise<void> {
    ctx.watchdog.stop(loopName)

    const retryTimeout = ctx.retryTimeouts.get(loopName)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      ctx.retryTimeouts.delete(loopName)
    }

    const idleRetryTimeout = ctx.idleRetryTimeouts.get(loopName)
    if (idleRetryTimeout) {
      clearTimeout(idleRetryTimeout)
      ctx.idleRetryTimeouts.delete(loopName)
    }
    ctx.idleRetryAttempts.delete(loopName)
    ctx.codingLaunchRecoveryAttempts.delete(loopName)

    const retained = ctx.loopRetainedSessions.get(loopName)
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
      ctx.loopRetainedSessions.delete(loopName)
    }
  }

  return {
    terminateLoop,
    tryTerminateLoop,
    terminateAll,
    terminateLoopByName,
    cancelBySessionId,
    clearLoopTimers,
    clearAllRetryTimeouts,
  }
}
