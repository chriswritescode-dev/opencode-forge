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
  | { type: 'coding-idle-complete' }
  | { type: 'section-clean'; isLastSection: boolean }
  | { type: 'section-dirty' }
  | { type: 'audit-clear' }
  | { type: 'audit-dirty' }
  | { type: 'final-audit-clean' }
  | { type: 'final-audit-dirty' }
  | { type: 'decomposer-complete'; sectionCount: number }
  | { type: 'decomposer-empty' }
  | { type: 'decomposition-failed' }
  | { type: 'iteration-cap' }
  | { type: 'user-abort' }
  | { type: 'shutdown' }
  | { type: 'stall-timeout' }
  | { type: 'error-max-retries'; context?: string }
  | { type: 'missing-worktree-dir' }
  | { type: 'worktree-failed'; message: string }
  | { type: 'decomposer-error'; message: string }
  | { type: 'session-creation-failed' }
  | { type: 'audit-retry-exhausted' }
  | { type: 'final-audit-retry-exhausted' }
  | { type: 'coding-no-assistant' }
  | { type: 'decomposer-prompt-failed' }

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

    case 'decomposing':
      return handleDecomposingEvent(event)

    case 'final_auditing':
      return handleFinalAuditEvent(event)
  }
}

function handleCodingEvent(event: TransitionEvent): Transition {
  switch (event.type) {
    case 'coding-idle-complete':
      return { kind: 'continue' }
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
    case 'decomposer-error':
      return { kind: 'terminate', reason: { kind: 'decomposer_error', message: event.message } }
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
        return { kind: 'continue' }
      }
      return { kind: 'advance-section' }
    case 'section-dirty':
      return { kind: 'continue' }
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
    case 'decomposer-error':
      return { kind: 'terminate', reason: { kind: 'decomposer_error', message: event.message } }
    case 'error-max-retries':
      return { kind: 'terminate', reason: { kind: 'error_max_retries', message: event.context ?? '' } }
    default:
      return { kind: 'noop' }
  }
}

function handleDecomposingEvent(event: TransitionEvent): Transition {
  switch (event.type) {
    case 'decomposer-complete':
      if (event.sectionCount > 0) {
        return { kind: 'continue' }
      }
      return { kind: 'terminate', reason: { kind: 'decomposition_failed' } }
    case 'decomposer-empty':
      return { kind: 'terminate', reason: { kind: 'decomposition_failed' } }
    case 'decomposition-failed':
      return { kind: 'terminate', reason: { kind: 'decomposition_failed' } }
    case 'missing-worktree-dir':
      return { kind: 'terminate', reason: { kind: 'missing_worktree_dir' } }
    case 'session-creation-failed':
      return { kind: 'terminate', reason: { kind: 'session_creation_failed' } }
    case 'decomposer-prompt-failed':
      return { kind: 'terminate', reason: { kind: 'decomposer_prompt_failed' } }
    case 'user-abort':
      return { kind: 'terminate', reason: { kind: 'user_aborted' } }
    case 'shutdown':
      return { kind: 'terminate', reason: { kind: 'shutdown' } }
    case 'stall-timeout':
      return { kind: 'terminate', reason: { kind: 'stall_timeout' } }
    case 'worktree-failed':
      return { kind: 'terminate', reason: { kind: 'worktree_failed', message: event.message } }
    case 'decomposer-error':
      return { kind: 'terminate', reason: { kind: 'decomposer_error', message: event.message } }
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
      return { kind: 'rewind-section' }
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
    case 'decomposer-error':
      return { kind: 'terminate', reason: { kind: 'decomposer_error', message: event.message } }
    case 'error-max-retries':
      return { kind: 'terminate', reason: { kind: 'error_max_retries', message: event.context ?? '' } }
    default:
      return { kind: 'noop' }
  }
}
