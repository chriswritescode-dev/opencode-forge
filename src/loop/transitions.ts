import type { LoopState } from './state'
import type { TerminationReason } from './termination'

export type Transition =
  | { kind: 'continue' }
  | { kind: 'rotate' }
  | { kind: 'advance-section' }
  | { kind: 'rewind-section' }
  | { kind: 'fix-for-final-audit' }
  | { kind: 'start-final-audit' }
  | { kind: 'terminate'; reason: TerminationReason }
  | { kind: 'noop' }

export type TransitionEvent =
  | { type: 'coding-idle-complete' }
  | { type: 'section-clean'; isLastSection: boolean }
  | { type: 'section-dirty' }
  | { type: 'audit-clear' }
  | { type: 'audit-dirty' }
  | { type: 'final-audit-clean' }
  | { type: 'final-audit-dirty' }
  | { type: 'iteration-cap' }
  | { type: 'user-abort' }
  | { type: 'shutdown' }
  | { type: 'stall-timeout' }
  | { type: 'error-max-retries'; context?: string }
  | { type: 'missing-worktree-dir' }
  | { type: 'worktree-failed'; message: string }
  | { type: 'session-creation-failed' }
  | { type: 'audit-retry-exhausted' }
  | { type: 'final-audit-retry-exhausted' }
  | { type: 'coding-no-assistant' }
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

    case 'final_auditing':
      return handleFinalAuditEvent(event)

    case 'post_action':
      return handlePostActionEvent(event)

    case 'final_audit_fix':
      return handleFinalAuditFixEvent(event)
  }
}

function handleCodingEvent(event: TransitionEvent): Transition {
  switch (event.type) {
    case 'coding-idle-complete':
      return { kind: 'rotate' }
    case 'missing-worktree-dir':
      return { kind: 'terminate', reason: { kind: 'missing_worktree_dir' } }
    case 'session-creation-failed':
      return { kind: 'terminate', reason: { kind: 'session_creation_failed' } }
    case 'coding-no-assistant':
      return { kind: 'terminate', reason: { kind: 'coding_no_assistant' } }
    case 'iteration-cap':
      return { kind: 'terminate', reason: { kind: 'max_iterations' } }
    case 'user-abort':
      return { kind: 'terminate', reason: { kind: 'user_aborted' } }
    case 'shutdown':
      return { kind: 'terminate', reason: { kind: 'shutdown' } }
    case 'stall-timeout':
      return { kind: 'terminate', reason: { kind: 'stall_timeout' } }
    case 'worktree-failed':
      return { kind: 'terminate', reason: { kind: 'worktree_failed', message: event.message } }
    case 'error-max-retries':
      return { kind: 'terminate', reason: { kind: 'error_max_retries', message: event.context ?? '' } }
    default:
      return { kind: 'noop' }
  }
}

function handleAuditingEvent(event: TransitionEvent): Transition {
  switch (event.type) {
    case 'section-clean':
      if (event.isLastSection) {
        return { kind: 'start-final-audit' }
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
    case 'audit-retry-exhausted':
      return { kind: 'terminate', reason: { kind: 'audit_retry_exhausted' } }
    case 'worktree-failed':
      return { kind: 'terminate', reason: { kind: 'worktree_failed', message: event.message } }
    case 'error-max-retries':
      return { kind: 'terminate', reason: { kind: 'error_max_retries', message: event.context ?? '' } }
    default:
      return { kind: 'noop' }
  }
}

function handleFinalAuditEvent(event: TransitionEvent): Transition {
  switch (event.type) {
    case 'final-audit-clean':
      return { kind: 'terminate', reason: { kind: 'completed' } }
    case 'final-audit-dirty':
      return { kind: 'fix-for-final-audit' }
    case 'final-audit-retry-exhausted':
      return { kind: 'terminate', reason: { kind: 'final_audit_retry_exhausted' } }
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
    case 'worktree-failed':
      return { kind: 'terminate', reason: { kind: 'worktree_failed', message: event.message } }
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
    case 'worktree-failed':
      return { kind: 'terminate', reason: { kind: 'worktree_failed', message: event.message } }
    case 'error-max-retries':
      return { kind: 'terminate', reason: { kind: 'error_max_retries', message: event.context ?? '' } }
    default:
      return { kind: 'noop' }
  }
}

function handleFinalAuditFixEvent(event: TransitionEvent): Transition {
  switch (event.type) {
    case 'coding-idle-complete':
      return { kind: 'start-final-audit' }
    case 'missing-worktree-dir':
      return { kind: 'terminate', reason: { kind: 'missing_worktree_dir' } }
    case 'session-creation-failed':
      return { kind: 'terminate', reason: { kind: 'session_creation_failed' } }
    case 'coding-no-assistant':
      return { kind: 'terminate', reason: { kind: 'coding_no_assistant' } }
    case 'iteration-cap':
      return { kind: 'terminate', reason: { kind: 'max_iterations' } }
    case 'user-abort':
      return { kind: 'terminate', reason: { kind: 'user_aborted' } }
    case 'shutdown':
      return { kind: 'terminate', reason: { kind: 'shutdown' } }
    case 'stall-timeout':
      return { kind: 'terminate', reason: { kind: 'stall_timeout' } }
    case 'worktree-failed':
      return { kind: 'terminate', reason: { kind: 'worktree_failed', message: event.message } }
    case 'error-max-retries':
      return { kind: 'terminate', reason: { kind: 'error_max_retries', message: event.context ?? '' } }
    default:
      return { kind: 'noop' }
  }
}
