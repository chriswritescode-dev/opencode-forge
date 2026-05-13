import { describe, it, expect } from 'vitest'
import {
  terminationStatusFor,
  terminationReasonToString,
  type TerminationReason,
} from '../../src/loop/termination'

describe('terminationStatusFor', () => {
  it('maps completed to completed', () => {
    expect(terminationStatusFor({ kind: 'completed' })).toBe('completed')
  })

  it('maps cancelled to cancelled', () => {
    expect(terminationStatusFor({ kind: 'cancelled' })).toBe('cancelled')
  })

  it('maps user_aborted to cancelled', () => {
    expect(terminationStatusFor({ kind: 'user_aborted' })).toBe('cancelled')
  })

  it('maps shutdown to cancelled', () => {
    expect(terminationStatusFor({ kind: 'shutdown' })).toBe('cancelled')
  })

  it('maps max_iterations to errored', () => {
    expect(terminationStatusFor({ kind: 'max_iterations' })).toBe('errored')
  })

  it('maps stall_timeout to stalled', () => {
    expect(terminationStatusFor({ kind: 'stall_timeout' })).toBe('stalled')
  })

  it('maps missing_worktree_dir to errored', () => {
    expect(terminationStatusFor({ kind: 'missing_worktree_dir' })).toBe('errored')
  })

  it('maps session_creation_failed to errored', () => {
    expect(terminationStatusFor({ kind: 'session_creation_failed' })).toBe('errored')
  })

  it('maps decomposition_failed to errored', () => {
    expect(terminationStatusFor({ kind: 'decomposition_failed' })).toBe('errored')
  })

  it('maps decomposer_prompt_failed to errored', () => {
    expect(terminationStatusFor({ kind: 'decomposer_prompt_failed' })).toBe('errored')
  })

  it('maps audit_retry_exhausted to errored', () => {
    expect(terminationStatusFor({ kind: 'audit_retry_exhausted' })).toBe('errored')
  })

  it('maps final_audit_retry_exhausted to errored', () => {
    expect(terminationStatusFor({ kind: 'final_audit_retry_exhausted' })).toBe('errored')
  })

  it('maps coding_no_assistant to errored', () => {
    expect(terminationStatusFor({ kind: 'coding_no_assistant' })).toBe('errored')
  })

  it('maps worktree_failed with message to errored', () => {
    expect(terminationStatusFor({ kind: 'worktree_failed', message: 'branch deleted' })).toBe('errored')
  })

  it('maps decomposer_error with message to errored', () => {
    expect(terminationStatusFor({ kind: 'decomposer_error', message: 'parse failed' })).toBe('errored')
  })

  it('maps error_max_retries with message to errored', () => {
    expect(terminationStatusFor({ kind: 'error_max_retries', message: 'assistant error' })).toBe('errored')
  })
})

describe('terminationReasonToString', () => {
  it('returns kind for simple reasons', () => {
    expect(terminationReasonToString({ kind: 'completed' })).toBe('completed')
  })

  it('returns kind for cancelled', () => {
    expect(terminationReasonToString({ kind: 'cancelled' })).toBe('cancelled')
  })

  it('returns kind for user_aborted', () => {
    expect(terminationReasonToString({ kind: 'user_aborted' })).toBe('user_aborted')
  })

  it('returns kind for shutdown', () => {
    expect(terminationReasonToString({ kind: 'shutdown' })).toBe('shutdown')
  })

  it('returns kind for max_iterations', () => {
    expect(terminationReasonToString({ kind: 'max_iterations' })).toBe('max_iterations')
  })

  it('returns kind for stall_timeout', () => {
    expect(terminationReasonToString({ kind: 'stall_timeout' })).toBe('stall_timeout')
  })

  it('stringifies worktree_failed with message', () => {
    const reason: TerminationReason = { kind: 'worktree_failed', message: 'branch not found' }
    expect(terminationReasonToString(reason)).toBe('worktree_failed: branch not found')
  })

  it('stringifies decomposer_error with message', () => {
    const reason: TerminationReason = { kind: 'decomposer_error', message: 'invalid JSON' }
    expect(terminationReasonToString(reason)).toBe('decomposer_error: invalid JSON')
  })

  it('stringifies error_max_retries with message', () => {
    const reason: TerminationReason = { kind: 'error_max_retries', message: 'assistant error: timeout' }
    expect(terminationReasonToString(reason)).toBe('error_max_retries: assistant error: timeout')
  })

  it('preserves missing_worktree_dir string exactly', () => {
    expect(terminationReasonToString({ kind: 'missing_worktree_dir' })).toBe('missing_worktree_dir')
  })

  it('preserves session_creation_failed string exactly', () => {
    expect(terminationReasonToString({ kind: 'session_creation_failed' })).toBe('session_creation_failed')
  })

  it('preserves decomposition_failed string exactly', () => {
    expect(terminationReasonToString({ kind: 'decomposition_failed' })).toBe('decomposition_failed')
  })

  it('preserves decomposer_prompt_failed string exactly', () => {
    expect(terminationReasonToString({ kind: 'decomposer_prompt_failed' })).toBe('decomposer_prompt_failed')
  })

  it('preserves audit_retry_exhausted string exactly', () => {
    expect(terminationReasonToString({ kind: 'audit_retry_exhausted' })).toBe('audit_retry_exhausted')
  })

  it('preserves final_audit_retry_exhausted string exactly', () => {
    expect(terminationReasonToString({ kind: 'final_audit_retry_exhausted' })).toBe('final_audit_retry_exhausted')
  })

  it('preserves coding_no_assistant string exactly', () => {
    expect(terminationReasonToString({ kind: 'coding_no_assistant' })).toBe('coding_no_assistant')
  })
})
