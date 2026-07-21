import type { RuntimeContext } from './runtime-context'
import type { LoopState } from './state'
import { transitionSectionIndex } from './state'
import type { TerminationReason } from './termination'
import { terminationStatusFor, terminationReasonToString } from './termination'
import type { TransitionEvent, Transition } from './transitions'

/**
 * Optional metadata passed into shared commit helpers (rotateAndSendContinuation,
 * startFinalAuditTransition) so the non-terminal transition row is recorded
 * AFTER the persisted phase commit but BEFORE the prompt send. Logging between
 * those two points guarantees (a) no phantom row when phase persistence fails
 * and (b) the row's id precedes any terminate row produced by a downstream
 * prompt-send failure (chronological id order).
 */
export interface TransitionLogEntry {
  eventType: string
  transitionKind: string
  fromPhase: LoopState['phase']
  toPhase: LoopState['phase'] | null
}

export interface TransitionLog {
  recordTransitionEntry(
    loopName: string,
    state: LoopState,
    entry: TransitionLogEntry,
    overrideIter?: number,
    overrideSection?: number | null,
  ): void
  logTransition(
    loopName: string,
    state: LoopState,
    event: TransitionEvent,
    trans: Transition,
    toPhase: LoopState['phase'] | null,
  ): void
  recordShutdownTransitionAndPersist(loopName: string, fresh: LoopState): void
}

export function createTransitionLog(ctx: RuntimeContext): TransitionLog {
  function recordTransitionEntry(
    loopName: string,
    state: LoopState,
    entry: TransitionLogEntry,
    overrideIter?: number,
    overrideSection?: number | null,
  ): void {
    ctx.loopService.recordTransition(loopName, {
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
    ctx.loopService.recordTransition(loopName, {
      eventType: shutdownReason.kind,
      transitionKind: 'terminate',
      fromPhase: fresh.phase,
      toPhase: null,
      status: shutdownStatus,
      reason: shutdownReasonText,
      iteration: fresh.iteration ?? 0,
      sectionIndex: transitionSectionIndex(fresh),
    })
    ctx.loopService.terminate(loopName, {
      status: shutdownStatus,
      reason: shutdownReasonText,
      completedAt: Date.now(),
    })
  }

  return { recordTransitionEntry, logTransition, recordShutdownTransitionAndPersist }
}
