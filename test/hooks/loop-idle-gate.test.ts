import { describe, test, expect, beforeEach, vi } from 'vitest'
import {
  markPromptSent,
  clearPromptPending,
  clearLoopPromptPending,
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
import type { LoopLane } from '../../src/loop/section-run'
import type { Logger } from '../../src/types'
import { createMockLogger } from '../helpers/logger'

const PROJECT_ID = 'test-project'

const LANE: LoopLane = { loopName: 'loop-1', sectionRunKey: 'plan' }
const LANE_A: LoopLane = { loopName: 'loop-A', sectionRunKey: 'plan' }
const LANE_B: LoopLane = { loopName: 'loop-B', sectionRunKey: 'plan' }
const LANE_SHARED: LoopLane = { loopName: 'loop-shared', sectionRunKey: 'plan' }
const LANE_NONEXISTENT: LoopLane = { loopName: 'loop-nonexistent', sectionRunKey: 'plan' }

describe('loop-idle-gate primitives', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
    __resetIdleGate()
  })

  test('markPromptSent then isAwaitingBusy returns true for matching sessionId', () => {
    markPromptSent(PROJECT_ID, LANE, 'session-abc', logger)
    expect(isAwaitingBusy(PROJECT_ID, LANE, 'session-abc')).toBe(true)
  })

  test('isAwaitingBusy returns false for non-matching sessionId on same lane', () => {
    markPromptSent(PROJECT_ID, LANE, 'session-abc', logger)
    expect(isAwaitingBusy(PROJECT_ID, LANE, 'session-xyz')).toBe(false)
  })

  test('clearPromptPending removes the entry; subsequent isAwaitingBusy returns false', () => {
    markPromptSent(PROJECT_ID, LANE, 'session-abc', logger)
    clearPromptPending(PROJECT_ID, LANE, logger)
    expect(isAwaitingBusy(PROJECT_ID, LANE, 'session-abc')).toBe(false)
  })

  test('clearPromptPending is a no-op if no entry exists', () => {
    clearPromptPending(PROJECT_ID, LANE_NONEXISTENT, logger)
    expect(isAwaitingBusy(PROJECT_ID, LANE_NONEXISTENT, 'session-abc')).toBe(false)
  })

  test('isAwaitingBusyExpired returns false within timeout', () => {
    markPromptSent(PROJECT_ID, LANE, 'session-abc', logger)
    expect(isAwaitingBusyExpired(PROJECT_ID, LANE)).toBe(false)
  })

  test('isAwaitingBusyExpired returns true after AWAITING_BUSY_TIMEOUT_MS', () => {
    vi.useFakeTimers()
    try {
      markPromptSent(PROJECT_ID, LANE, 'session-abc', logger)
      const now = Date.now()
      vi.setSystemTime(now + AWAITING_BUSY_TIMEOUT_MS + 1)
      expect(isAwaitingBusyExpired(PROJECT_ID, LANE)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('multiple loops are independent', () => {
    markPromptSent(PROJECT_ID, LANE_A, 'session-A1', logger)
    markPromptSent(PROJECT_ID, LANE_B, 'session-B1', logger)

    expect(isAwaitingBusy(PROJECT_ID, LANE_A, 'session-A1')).toBe(true)
    expect(isAwaitingBusy(PROJECT_ID, LANE_B, 'session-B1')).toBe(true)
    expect(isAwaitingBusy(PROJECT_ID, LANE_A, 'session-B1')).toBe(false)
    expect(isAwaitingBusy(PROJECT_ID, LANE_B, 'session-A1')).toBe(false)

    clearPromptPending(PROJECT_ID, LANE_A, logger)
    expect(isAwaitingBusy(PROJECT_ID, LANE_A, 'session-A1')).toBe(false)
    expect(isAwaitingBusy(PROJECT_ID, LANE_B, 'session-B1')).toBe(true)
  })

  test('two lanes of the same loop hold independent entries', () => {
    const laneSection: LoopLane = { loopName: 'loop-lanes', sectionRunKey: 'section:section-1' }
    const lanePlan: LoopLane = { loopName: 'loop-lanes', sectionRunKey: 'plan' }

    markPromptSent(PROJECT_ID, laneSection, 'session-section', logger)
    markPromptSent(PROJECT_ID, lanePlan, 'session-plan', logger)

    expect(isAwaitingBusy(PROJECT_ID, laneSection, 'session-section')).toBe(true)
    expect(isAwaitingBusy(PROJECT_ID, lanePlan, 'session-plan')).toBe(true)
    expect(isAwaitingBusy(PROJECT_ID, laneSection, 'session-plan')).toBe(false)
    expect(isAwaitingBusy(PROJECT_ID, lanePlan, 'session-section')).toBe(false)
  })

  test('clearLoopPromptPending removes every lane of that loop and leaves another loop untouched', () => {
    const laneSection: LoopLane = { loopName: 'loop-lanes', sectionRunKey: 'section:section-1' }
    const lanePlan: LoopLane = { loopName: 'loop-lanes', sectionRunKey: 'plan' }

    markPromptSent(PROJECT_ID, laneSection, 'session-section', logger)
    markPromptSent(PROJECT_ID, lanePlan, 'session-plan', logger)
    markPromptSent(PROJECT_ID, LANE_B, 'session-B1', logger)

    clearLoopPromptPending(PROJECT_ID, 'loop-lanes', logger)

    expect(isAwaitingBusy(PROJECT_ID, laneSection, 'session-section')).toBe(false)
    expect(isAwaitingBusy(PROJECT_ID, lanePlan, 'session-plan')).toBe(false)
    expect(isAwaitingBusy(PROJECT_ID, LANE_B, 'session-B1')).toBe(true)
  })

  test('markPromptSent overwrites previous entry for same lane', () => {
    markPromptSent(PROJECT_ID, LANE, 'session-old', logger)
    markPromptSent(PROJECT_ID, LANE, 'session-new', logger)

    expect(isAwaitingBusy(PROJECT_ID, LANE, 'session-old')).toBe(false)
    expect(isAwaitingBusy(PROJECT_ID, LANE, 'session-new')).toBe(true)
  })

  test('__resetIdleGate clears awaiting-busy markers', () => {
    markPromptSent(PROJECT_ID, LANE, 'session-abc', logger)
    __resetIdleGate()
    expect(isAwaitingBusy(PROJECT_ID, LANE, 'session-abc')).toBe(false)
  })

  test('state is shared across separate module copies in the same process', async () => {
    vi.resetModules()
    const first = await import('../../src/loop/idle-gate')
    first.markPromptSent(PROJECT_ID, LANE_SHARED, 'session-shared', logger)
    first.recordInboxEnqueued('session-shared', 'inbox-shared')
    first.recordSuppressedIdle('session-shared')

    vi.resetModules()
    const second = await import('../../src/loop/idle-gate')

    expect(second).not.toBe(first)
    expect(second.isAwaitingBusy(PROJECT_ID, LANE_SHARED, 'session-shared')).toBe(true)
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
