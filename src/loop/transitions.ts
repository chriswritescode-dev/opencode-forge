import type { LoopState } from './state'
import type { TerminationReason } from './termination'

export type Transition =
  | { kind: 'continue' }
  | { kind: 'rotate' }
  | { kind: 'advance-section' }
  | { kind: 'rewind-section' }
  | { kind: 'terminate'; reason: TerminationReason }
  | { kind: 'noop' }

export type TransitionEvent =
  | { type: 'coder-handoff' }
  | { type: 'section-clean'; isLastOpenSection: boolean }
  | { type: 'section-dirty' }
  | { type: 'audit-clear' }
  | { type: 'audit-dirty' }
  | { type: 'iteration-cap' }
  | { type: 'user-abort' }
  | { type: 'shutdown' }
  | { type: 'stall-timeout' }
  | { type: 'error-max-retries'; context?: string }
  | { type: 'missing-worktree-dir' }
  | { type: 'session-creation-failed' }
  | { type: 'handoff-missing' }
  | { type: 'post-action-complete' }

/**
 * Pure transition table that mirrors the existing phase-handler behavior.
 * Switches first on `state.phase`, then on `event.type`.
 * Contains no side effects — no repo calls, no client calls,
 * no timers, no logging, no prompt sending, no filesystem access.
 */
export function nextTransition(state: LoopState, event: TransitionEvent): Transition {
  switch (state.phase) {
    case 'coding':
      return handleCodingEvent(event)

    case 'auditing':
      return handleAuditingEvent(event)

    case 'post_action':
      return handlePostActionEvent(event)
  }
}

function handleCodingEvent(event: TransitionEvent): Transition {
  switch (event.type) {
    case 'coder-handoff':
      return { kind: 'rotate' }
    case 'missing-worktree-dir':
      return { kind: 'terminate', reason: { kind: 'missing_worktree_dir' } }
    case 'session-creation-failed':
      return { kind: 'terminate', reason: { kind: 'session_creation_failed' } }
    case 'handoff-missing':
      return { kind: 'terminate', reason: { kind: 'handoff_missing' } }
    case 'iteration-cap':
      return { kind: 'terminate', reason: { kind: 'max_iterations' } }
    case 'user-abort':
      return { kind: 'terminate', reason: { kind: 'user_aborted' } }
    case 'shutdown':
      return { kind: 'terminate', reason: { kind: 'shutdown' } }
    case 'stall-timeout':
      return { kind: 'terminate', reason: { kind: 'stall_timeout' } }
    case 'error-max-retries':
      return { kind: 'terminate', reason: { kind: 'error_max_retries', message: event.context ?? '' } }
    default:
      return { kind: 'noop' }
  }
}

function handleAuditingEvent(event: TransitionEvent): Transition {
  switch (event.type) {
    case 'section-clean':
      if (event.isLastOpenSection) {
        return { kind: 'terminate', reason: { kind: 'completed' } }
      }
      return { kind: 'advance-section' }
    case 'section-dirty':
      return { kind: 'rotate' }
    case 'audit-clear':
      return { kind: 'terminate', reason: { kind: 'completed' } }
    case 'audit-dirty':
      return { kind: 'continue' }
    case 'iteration-cap':
      return { kind: 'terminate', reason: { kind: 'max_iterations' } }
    case 'user-abort':
      return { kind: 'terminate', reason: { kind: 'user_aborted' } }
    case 'shutdown':
      return { kind: 'terminate', reason: { kind: 'shutdown' } }
    case 'stall-timeout':
      return { kind: 'terminate', reason: { kind: 'stall_timeout' } }
    case 'missing-worktree-dir':
      return { kind: 'terminate', reason: { kind: 'missing_worktree_dir' } }
    case 'handoff-missing':
      return { kind: 'terminate', reason: { kind: 'handoff_missing' } }
    case 'error-max-retries':
      return { kind: 'terminate', reason: { kind: 'error_max_retries', message: event.context ?? '' } }
    default:
      return { kind: 'noop' }
  }
}

function handlePostActionEvent(event: TransitionEvent): Transition {
  switch (event.type) {
    case 'post-action-complete':
      return { kind: 'terminate', reason: { kind: 'completed' } }
    case 'handoff-missing':
      return { kind: 'terminate', reason: { kind: 'completed' } }
    case 'iteration-cap':
      return { kind: 'terminate', reason: { kind: 'max_iterations' } }
    case 'user-abort':
      return { kind: 'terminate', reason: { kind: 'user_aborted' } }
    case 'shutdown':
      return { kind: 'terminate', reason: { kind: 'shutdown' } }
    case 'stall-timeout':
      return { kind: 'terminate', reason: { kind: 'stall_timeout' } }
    case 'missing-worktree-dir':
      return { kind: 'terminate', reason: { kind: 'missing_worktree_dir' } }
    case 'error-max-retries':
      return { kind: 'terminate', reason: { kind: 'error_max_retries', message: event.context ?? '' } }
    default:
      return { kind: 'noop' }
  }
}
