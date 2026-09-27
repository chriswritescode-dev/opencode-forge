import { describe, test, expect, beforeEach, vi } from 'vitest'
import {
  markPromptSent,
  clearPromptPending,
  isAwaitingBusy,
  isAwaitingBusyExpired,
  AWAITING_BUSY_TIMEOUT_MS,
  recordInboxEnqueued,
  recordInboxSettled,
  isPromptQueued,
  QUEUED_PROMPT_MAX_AGE_MS,
  recordSuppressedIdle,
  hasSuppressedIdle,
  consumeSuppressedIdle,
  clearSuppressedIdle,
  clearIdleGateForSession,
  __resetIdleGate,
} from '../../src/loop/idle-gate'
import type { Logger } from '../../src/types'

const PROJECT_ID = 'test-project'

function createMockLogger(): Logger {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

describe('loop-idle-gate primitives', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
    __resetIdleGate()
  })

  test('markPromptSent then isAwaitingBusy returns true for matching sessionId', () => {
    markPromptSent(PROJECT_ID, 'loop-1', 'session-abc', logger)
    expect(isAwaitingBusy(PROJECT_ID, 'loop-1', 'session-abc')).toBe(true)
  })

  test('isAwaitingBusy returns false for non-matching sessionId on same loopName', () => {
    markPromptSent(PROJECT_ID, 'loop-1', 'session-abc', logger)
    expect(isAwaitingBusy(PROJECT_ID, 'loop-1', 'session-xyz')).toBe(false)
  })

  test('clearPromptPending removes the entry; subsequent isAwaitingBusy returns false', () => {
    markPromptSent(PROJECT_ID, 'loop-1', 'session-abc', logger)
    clearPromptPending(PROJECT_ID, 'loop-1', logger)
    expect(isAwaitingBusy(PROJECT_ID, 'loop-1', 'session-abc')).toBe(false)
  })

  test('clearPromptPending is a no-op if no entry exists', () => {
    clearPromptPending(PROJECT_ID, 'loop-nonexistent', logger)
    expect(isAwaitingBusy(PROJECT_ID, 'loop-nonexistent', 'session-abc')).toBe(false)
  })

  test('isAwaitingBusyExpired returns false within timeout', () => {
    markPromptSent(PROJECT_ID, 'loop-1', 'session-abc', logger)
    expect(isAwaitingBusyExpired(PROJECT_ID, 'loop-1')).toBe(false)
  })

  test('isAwaitingBusyExpired returns true after AWAITING_BUSY_TIMEOUT_MS', () => {
    vi.useFakeTimers()
    try {
      markPromptSent(PROJECT_ID, 'loop-1', 'session-abc', logger)
      const now = Date.now()
      vi.setSystemTime(now + AWAITING_BUSY_TIMEOUT_MS + 1)
      expect(isAwaitingBusyExpired(PROJECT_ID, 'loop-1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('multiple loops are independent', () => {
    markPromptSent(PROJECT_ID, 'loop-A', 'session-A1', logger)
    markPromptSent(PROJECT_ID, 'loop-B', 'session-B1', logger)

    expect(isAwaitingBusy(PROJECT_ID, 'loop-A', 'session-A1')).toBe(true)
    expect(isAwaitingBusy(PROJECT_ID, 'loop-B', 'session-B1')).toBe(true)
    expect(isAwaitingBusy(PROJECT_ID, 'loop-A', 'session-B1')).toBe(false)
    expect(isAwaitingBusy(PROJECT_ID, 'loop-B', 'session-A1')).toBe(false)

    clearPromptPending(PROJECT_ID, 'loop-A', logger)
    expect(isAwaitingBusy(PROJECT_ID, 'loop-A', 'session-A1')).toBe(false)
    expect(isAwaitingBusy(PROJECT_ID, 'loop-B', 'session-B1')).toBe(true)
  })

  test('markPromptSent overwrites previous entry for same loopName', () => {
    markPromptSent(PROJECT_ID, 'loop-1', 'session-old', logger)
    markPromptSent(PROJECT_ID, 'loop-1', 'session-new', logger)

    expect(isAwaitingBusy(PROJECT_ID, 'loop-1', 'session-old')).toBe(false)
    expect(isAwaitingBusy(PROJECT_ID, 'loop-1', 'session-new')).toBe(true)
  })

  test('__resetIdleGate clears awaiting-busy markers', () => {
    markPromptSent(PROJECT_ID, 'loop-1', 'session-abc', logger)
    __resetIdleGate()
    expect(isAwaitingBusy(PROJECT_ID, 'loop-1', 'session-abc')).toBe(false)
  })

  test('state is shared across separate module copies in the same process', async () => {
    vi.resetModules()
    const first = await import('../../src/loop/idle-gate')
    first.markPromptSent(PROJECT_ID, 'loop-shared', 'session-shared', logger)
    first.recordInboxEnqueued('session-shared', 'inbox-shared')
    first.recordSuppressedIdle('session-shared')

    vi.resetModules()
    const second = await import('../../src/loop/idle-gate')

    expect(second).not.toBe(first)
    expect(second.isAwaitingBusy(PROJECT_ID, 'loop-shared', 'session-shared')).toBe(true)
    expect(second.isPromptQueued('session-shared')).toBe(true)
    expect(second.hasSuppressedIdle('session-shared')).toBe(true)
    second.__resetIdleGate()
  })
})

describe('queued-prompt tracking', () => {
  beforeEach(() => {
    __resetIdleGate()
  })

  test('recordInboxEnqueued then isPromptQueued returns true for the session', () => {
    recordInboxEnqueued('session-abc', 'inbox-1')
    expect(isPromptQueued('session-abc')).toBe(true)
    expect(isPromptQueued('session-xyz')).toBe(false)
  })

  test('recordInboxSettled clears a single item; other queued items keep the session queued', () => {
    recordInboxEnqueued('session-abc', 'inbox-1')
    recordInboxEnqueued('session-abc', 'inbox-2')
    recordInboxSettled('session-abc', 'inbox-1')
    expect(isPromptQueued('session-abc')).toBe(true)
    recordInboxSettled('session-abc', 'inbox-2')
    expect(isPromptQueued('session-abc')).toBe(false)
  })

  test('recordInboxSettled is a no-op for unknown session or item', () => {
    recordInboxSettled('session-unknown', 'inbox-1')
    recordInboxEnqueued('session-abc', 'inbox-1')
    recordInboxSettled('session-abc', 'inbox-other')
    expect(isPromptQueued('session-abc')).toBe(true)
  })

  test('isPromptQueued prunes entries older than QUEUED_PROMPT_MAX_AGE_MS', () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      recordInboxEnqueued('session-abc', 'inbox-1', now)
      expect(isPromptQueued('session-abc', now + QUEUED_PROMPT_MAX_AGE_MS - 1)).toBe(true)
      expect(isPromptQueued('session-abc', now + QUEUED_PROMPT_MAX_AGE_MS + 1)).toBe(false)
      // The stale entry was pruned, so settling it is a no-op and the session stays unqueued.
      recordInboxSettled('session-abc', 'inbox-1')
      expect(isPromptQueued('session-abc', now + QUEUED_PROMPT_MAX_AGE_MS + 1)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test('enqueuing sweeps aged entries across every session', () => {
    const base = Date.now()
    recordInboxEnqueued('session-old', 'inbox-old', base)
    recordInboxEnqueued('session-new', 'inbox-new', base + QUEUED_PROMPT_MAX_AGE_MS + 1)
    expect(isPromptQueued('session-old', base + QUEUED_PROMPT_MAX_AGE_MS + 1)).toBe(false)
    expect(isPromptQueued('session-new', base + QUEUED_PROMPT_MAX_AGE_MS + 1)).toBe(true)
  })

  test('multiple sessions are independent', () => {
    recordInboxEnqueued('session-a', 'inbox-a')
    recordInboxEnqueued('session-b', 'inbox-b')
    recordInboxSettled('session-a', 'inbox-a')
    expect(isPromptQueued('session-a')).toBe(false)
    expect(isPromptQueued('session-b')).toBe(true)
  })

  test('the same inbox event received twice is idempotent', () => {
    recordInboxEnqueued('session-abc', 'inbox-1')
    recordInboxEnqueued('session-abc', 'inbox-1')
    recordInboxSettled('session-abc', 'inbox-1')
    expect(isPromptQueued('session-abc')).toBe(false)
  })
})

describe('suppressed-idle tracking', () => {
  beforeEach(() => {
    __resetIdleGate()
  })

  test('a suppression is consumed exactly once', () => {
    recordSuppressedIdle('session-abc')
    expect(hasSuppressedIdle('session-abc')).toBe(true)
    expect(consumeSuppressedIdle('session-abc')).toBe(true)
    expect(consumeSuppressedIdle('session-abc')).toBe(false)
    expect(hasSuppressedIdle('session-abc')).toBe(false)
  })

  test('clearSuppressedIdle drops the marker without consuming it', () => {
    recordSuppressedIdle('session-abc')
    clearSuppressedIdle('session-abc')
    expect(hasSuppressedIdle('session-abc')).toBe(false)
  })

  test('clearIdleGateForSession clears queued prompts and the suppressed idle', () => {
    recordInboxEnqueued('session-abc', 'inbox-1')
    recordSuppressedIdle('session-abc')
    clearIdleGateForSession('session-abc')
    expect(isPromptQueued('session-abc')).toBe(false)
    expect(hasSuppressedIdle('session-abc')).toBe(false)
  })

  test('clearIdleGateForSession leaves other sessions untouched and is idempotent', () => {
    recordInboxEnqueued('session-a', 'inbox-a')
    recordSuppressedIdle('session-a')
    recordInboxEnqueued('session-b', 'inbox-b')
    clearIdleGateForSession('session-a')
    clearIdleGateForSession('session-a')
    expect(isPromptQueued('session-a')).toBe(false)
    expect(isPromptQueued('session-b')).toBe(true)
    expect(hasSuppressedIdle('session-b')).toBe(false)
  })
})
