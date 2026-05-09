import { describe, test, expect, beforeEach, vi } from 'vitest'
import {
  sessionsAwaitingBusy,
  markPromptSent,
  clearPromptPending,
  isAwaitingBusy,
  isAwaitingBusyExpired,
  AWAITING_BUSY_TIMEOUT_MS,
} from '../../src/hooks/loop-idle-gate'
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
})
