import { describe, it, expect } from 'vitest'
import {
  terminationStatusFor,
  terminationReasonToString,
  parseTerminationReasonString,
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

  it('maps handoff_missing to errored', () => {
    expect(terminationStatusFor({ kind: 'handoff_missing' })).toBe('errored')
  })

  it('maps worktree_failed with message to errored', () => {
    expect(terminationStatusFor({ kind: 'worktree_failed', message: 'branch deleted' })).toBe('errored')
  })

  it('maps error_max_retries with message to errored', () => {
    expect(terminationStatusFor({ kind: 'error_max_retries', message: 'assistant error' })).toBe('errored')
  })

  it('maps provider_limit with message to errored', () => {
    expect(terminationStatusFor({ kind: 'provider_limit', message: 'usage limit hit' })).toBe('errored')
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

  it('preserves handoff_missing string exactly', () => {
    expect(terminationReasonToString({ kind: 'handoff_missing' })).toBe('handoff_missing')
  })

  it('stringifies provider_limit with message', () => {
    const reason: TerminationReason = { kind: 'provider_limit', message: 'usage limit hit' }
    expect(terminationReasonToString(reason)).toBe('provider_limit: usage limit hit')
  })
})

describe('parseTerminationReasonString', () => {
  it('round-trips provider_limit', () => {
    const reason: TerminationReason = { kind: 'provider_limit', message: 'usage limit hit' }
    const str = terminationReasonToString(reason)
    expect(parseTerminationReasonString(str)).toEqual(reason)
  })

  it('parses handoff_missing', () => {
    expect(parseTerminationReasonString('handoff_missing')).toEqual({ kind: 'handoff_missing' })
  })

  it('parses retired reason strings as error_max_retries', () => {
    expect(parseTerminationReasonString('audit_retry_exhausted')).toEqual({ kind: 'error_max_retries', message: 'audit_retry_exhausted' })
    expect(parseTerminationReasonString('coding_no_assistant')).toEqual({ kind: 'error_max_retries', message: 'coding_no_assistant' })
  })
})
