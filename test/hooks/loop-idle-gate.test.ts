import { describe, test, expect, beforeEach, vi } from 'vitest'
import {
  sessionsAwaitingBusy,
  markPromptSent,
  clearPromptPending,
  isAwaitingBusy,
  isAwaitingBusyExpired,
  AWAITING_BUSY_TIMEOUT_MS,
  recordInboxEnqueued,
  recordInboxSettled,
  isPromptQueued,
  QUEUED_PROMPT_MAX_AGE_MS,
  __resetQueuedPrompts,
} from '../../src/loop/idle-gate'
import type { Logger } from '../../src/types'

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
    sessionsAwaitingBusy.clear()
    __resetQueuedPrompts()
  })

  test('markPromptSent then isAwaitingBusy returns true for matching sessionId', () => {
    markPromptSent('loop-1', 'session-abc', logger)
    expect(isAwaitingBusy('loop-1', 'session-abc')).toBe(true)
  })

  test('isAwaitingBusy returns false for non-matching sessionId on same loopName', () => {
    markPromptSent('loop-1', 'session-abc', logger)
    expect(isAwaitingBusy('loop-1', 'session-xyz')).toBe(false)
  })

  test('clearPromptPending removes the entry; subsequent isAwaitingBusy returns false', () => {
    markPromptSent('loop-1', 'session-abc', logger)
    clearPromptPending('loop-1', logger)
    expect(isAwaitingBusy('loop-1', 'session-abc')).toBe(false)
  })

  test('clearPromptPending is a no-op if no entry exists', () => {
    clearPromptPending('loop-nonexistent', logger)
    expect(isAwaitingBusy('loop-nonexistent', 'session-abc')).toBe(false)
  })

  test('isAwaitingBusyExpired returns false within timeout', () => {
    markPromptSent('loop-1', 'session-abc', logger)
    expect(isAwaitingBusyExpired('loop-1')).toBe(false)
  })

  test('isAwaitingBusyExpired returns true after AWAITING_BUSY_TIMEOUT_MS', () => {
    vi.useFakeTimers()
    try {
      markPromptSent('loop-1', 'session-abc', logger)
      const now = Date.now()
      vi.setSystemTime(now + AWAITING_BUSY_TIMEOUT_MS + 1)
      expect(isAwaitingBusyExpired('loop-1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('multiple loops are independent', () => {
    markPromptSent('loop-A', 'session-A1', logger)
    markPromptSent('loop-B', 'session-B1', logger)

    expect(isAwaitingBusy('loop-A', 'session-A1')).toBe(true)
    expect(isAwaitingBusy('loop-B', 'session-B1')).toBe(true)
    expect(isAwaitingBusy('loop-A', 'session-B1')).toBe(false)
    expect(isAwaitingBusy('loop-B', 'session-A1')).toBe(false)

    clearPromptPending('loop-A', logger)
    expect(isAwaitingBusy('loop-A', 'session-A1')).toBe(false)
    expect(isAwaitingBusy('loop-B', 'session-B1')).toBe(true)
  })

  test('markPromptSent overwrites previous entry for same loopName', () => {
    markPromptSent('loop-1', 'session-old', logger)
    markPromptSent('loop-1', 'session-new', logger)

    expect(isAwaitingBusy('loop-1', 'session-old')).toBe(false)
    expect(isAwaitingBusy('loop-1', 'session-new')).toBe(true)
  })

  test('sessionsAwaitingBusy Map is exported and accessible', () => {
    expect(sessionsAwaitingBusy).toBeInstanceOf(Map)
    expect(sessionsAwaitingBusy.size).toBe(0)
    markPromptSent('loop-1', 'session-abc', logger)
    expect(sessionsAwaitingBusy.size).toBe(1)
  })

  test('state is shared across separate module copies in the same process', async () => {
    vi.resetModules()
    const first = await import('../../src/loop/idle-gate')
    first.markPromptSent('loop-shared', 'session-shared', logger)
    first.recordInboxEnqueued('session-shared', 'inbox-shared')

    vi.resetModules()
    const second = await import('../../src/loop/idle-gate')

    expect(second).not.toBe(first)
    expect(second.isAwaitingBusy('loop-shared', 'session-shared')).toBe(true)
    expect(second.isPromptQueued('session-shared')).toBe(true)
  })
})

describe('queued-prompt tracking', () => {
  beforeEach(() => {
    __resetQueuedPrompts()
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
