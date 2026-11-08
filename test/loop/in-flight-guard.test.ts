import { describe, test, expect, beforeEach } from 'vitest'
import {
  markPromptInFlight,
  clearPromptInFlight,
  clearPromptInFlightIfMatches,
  clearPromptInFlightBySession,
  clearLoopPromptInFlight,
  withInFlightGuard,
  assertNoPromptInFlight,
  getPromptInFlight,
  ConcurrentPromptError,
  __resetInFlightGuard,
} from '../../src/loop/in-flight-guard'
import type { LoopLane } from '../../src/loop/section-run'
import { createMockLogger } from '../helpers/logger'

const PROJECT_ID = 'test-project'

const lane = (loopName: string, sectionRunKey = 'plan'): LoopLane => ({ loopName, sectionRunKey })

describe('in-flight guard', () => {
  beforeEach(() => {
    __resetInFlightGuard()
  })

  test('rejects concurrent prompt for same lane with different session/agent', () => {
    markPromptInFlight(PROJECT_ID, lane('loopA'), 'sess-1', 'code')
    const logger = createMockLogger()

    expect(() =>
      assertNoPromptInFlight(PROJECT_ID, lane('loopA'), 'sess-2', 'auditor-loop', logger)
    ).toThrow(ConcurrentPromptError)

    expect(logger.error.mock.calls.length).toBe(1)
    expect(logger.error.mock.calls[0][0]).toContain('concurrent prompt rejected')
    expect(logger.error.mock.calls[0][0]).toContain('loopA')
    expect(logger.error.mock.calls[0][0]).toContain('sess-1')
    expect(logger.error.mock.calls[0][0]).toContain('sess-2')
  })

  test('assertNoPromptInFlight returns without throwing after clear', () => {
    markPromptInFlight(PROJECT_ID, lane('loopA'), 'sess-1', 'code')
    clearPromptInFlight(PROJECT_ID, lane('loopA'))

    const logger = createMockLogger()
    expect(() =>
      assertNoPromptInFlight(PROJECT_ID, lane('loopA'), 'sess-2', 'auditor-loop', logger)
    ).not.toThrow()
  })

  test('guards are per-lane (section runs of one loop and other loops are independent)', () => {
    markPromptInFlight(PROJECT_ID, lane('loopB'), 'sess-3', 'code')

    const logger = createMockLogger()
    expect(() =>
      assertNoPromptInFlight(PROJECT_ID, lane('loopA'), 'sess-4', 'auditor-loop', logger)
    ).not.toThrow()
    expect(() =>
      assertNoPromptInFlight(PROJECT_ID, lane('loopB', 'section:section-1'), 'sess-3', 'code', logger)
    ).not.toThrow()
  })

  test('two lanes of the same loop are independent', () => {
    const lanePlan = lane('loopLanes', 'plan')
    const laneSection = lane('loopLanes', 'section:section-1')

    markPromptInFlight(PROJECT_ID, lanePlan, 'sess-plan', 'code')

    const logger = createMockLogger()
    expect(() =>
      assertNoPromptInFlight(PROJECT_ID, laneSection, 'sess-section', 'auditor-loop', logger)
    ).not.toThrow()

    markPromptInFlight(PROJECT_ID, laneSection, 'sess-section', 'auditor-loop')
    clearPromptInFlight(PROJECT_ID, lanePlan)

    expect(getPromptInFlight(PROJECT_ID, lanePlan)).toBeUndefined()
    expect(getPromptInFlight(PROJECT_ID, laneSection)!.sessionId).toBe('sess-section')
  })

  test('clearLoopPromptInFlight clears every lane of that loop but not another loop', () => {
    const lanePlan = lane('loopLanes', 'plan')
    const laneSection = lane('loopLanes', 'section:section-1')
    const laneOther = lane('loopOther')

    markPromptInFlight(PROJECT_ID, lanePlan, 'sess-plan', 'code')
    markPromptInFlight(PROJECT_ID, laneSection, 'sess-section', 'auditor-loop')
    markPromptInFlight(PROJECT_ID, laneOther, 'sess-other', 'code')

    clearLoopPromptInFlight(PROJECT_ID, 'loopLanes')

    expect(getPromptInFlight(PROJECT_ID, lanePlan)).toBeUndefined()
    expect(getPromptInFlight(PROJECT_ID, laneSection)).toBeUndefined()
    expect(getPromptInFlight(PROJECT_ID, laneOther)).toBeDefined()
  })

  test('rejects concurrent prompt for same lane with same session and agent', () => {
    markPromptInFlight(PROJECT_ID, lane('loopD'), 'sess-7', 'auditor-loop')
    const logger = createMockLogger()

    expect(() =>
      assertNoPromptInFlight(PROJECT_ID, lane('loopD'), 'sess-7', 'auditor-loop', logger)
    ).toThrow(ConcurrentPromptError)

    expect(logger.error.mock.calls.length).toBe(1)
    const msg = logger.error.mock.calls[0][0] as string
    expect(msg).toContain('[in-flight-guard]')
    expect(msg).toContain('loop=loopD')
    expect(msg).toContain('prior=auditor-loop: sess-7')
    expect(msg).toContain('attempted=auditor-loop: sess-7')
  })

  test('logger.error is called exactly once with correct details before throwing', () => {
    markPromptInFlight(PROJECT_ID, lane('loopC'), 'sess-5', 'auditor-loop')
    const logger = createMockLogger()

    try {
      assertNoPromptInFlight(PROJECT_ID, lane('loopC'), 'sess-6', 'code', logger)
      expect.fail('should have thrown')
    } catch {
      // expected
    }

    expect(logger.error.mock.calls.length).toBe(1)
    const msg = logger.error.mock.calls[0][0] as string
    expect(msg).toContain('[in-flight-guard]')
    expect(msg).toContain('loop=loopC')
    expect(msg).toContain('prior=auditor-loop: sess-5')
    expect(msg).toContain('attempted=code: sess-6')
  })

  test('clearPromptInFlightIfMatches clears matching owner', () => {
    markPromptInFlight(PROJECT_ID, lane('loopE'), 'sess-9', 'code')
    const result = clearPromptInFlightIfMatches(PROJECT_ID, lane('loopE'), 'sess-9', 'code')
    expect(result).toBe(true)
    expect(getPromptInFlight(PROJECT_ID, lane('loopE'))).toBeUndefined()
  })

  test('clearPromptInFlightIfMatches preserves non-matching owner', () => {
    markPromptInFlight(PROJECT_ID, lane('loopF'), 'sess-10', 'auditor-loop')
    const result = clearPromptInFlightIfMatches(PROJECT_ID, lane('loopF'), 'sess-10', 'code')
    expect(result).toBe(false)
    expect(getPromptInFlight(PROJECT_ID, lane('loopF'))).toBeDefined()
    expect(getPromptInFlight(PROJECT_ID, lane('loopF'))!.sessionId).toBe('sess-10')
    expect(getPromptInFlight(PROJECT_ID, lane('loopF'))!.agent).toBe('auditor-loop')
  })
})

describe('clearPromptInFlightBySession', () => {
  beforeEach(() => {
    __resetInFlightGuard()
  })

  test('clears entry when session matches (any agent)', () => {
    markPromptInFlight(PROJECT_ID, lane('loopX'), 'sess-A', 'auditor-loop')
    const result = clearPromptInFlightBySession(PROJECT_ID, lane('loopX'), 'sess-A')
    expect(result).toBe(true)
    expect(getPromptInFlight(PROJECT_ID, lane('loopX'))).toBeUndefined()
  })

  test('preserves entry when session differs', () => {
    markPromptInFlight(PROJECT_ID, lane('loopY'), 'sess-A', 'code')
    const result = clearPromptInFlightBySession(PROJECT_ID, lane('loopY'), 'sess-B')
    expect(result).toBe(false)
    expect(getPromptInFlight(PROJECT_ID, lane('loopY'))).toBeDefined()
    expect(getPromptInFlight(PROJECT_ID, lane('loopY'))!.sessionId).toBe('sess-A')
  })

  test('returns false when no entry exists', () => {
    const result = clearPromptInFlightBySession(PROJECT_ID, lane('loopZ'), 'sess-A')
    expect(result).toBe(false)
  })
})

describe('withInFlightGuard', () => {
  beforeEach(() => {
    __resetInFlightGuard()
  })

  test('passes through return value when no concurrent prompt is in-flight', async () => {
    const logger = createMockLogger()
    const result = await withInFlightGuard(PROJECT_ID, lane('loopA'), 'sess-1', 'code', logger, async () => 'ok')
    expect(result).toEqual('ok')
    expect(getPromptInFlight(PROJECT_ID, lane('loopA'))).toBeUndefined()
  })

  test('marks in-flight while fn runs, clears after', async () => {
    const logger = createMockLogger()
    let duringEntry: ReturnType<typeof getPromptInFlight> = undefined
    await withInFlightGuard(PROJECT_ID, lane('loopB'), 'sess-2', 'auditor-loop', logger, async () => {
      duringEntry = getPromptInFlight(PROJECT_ID, lane('loopB'))
      return 'done'
    })
    expect(duringEntry).toBeDefined()
    expect(duringEntry!.sessionId).toBe('sess-2')
    expect(duringEntry!.agent).toBe('auditor-loop')
    expect(getPromptInFlight(PROJECT_ID, lane('loopB'))).toBeUndefined()
  })

  test('throws ConcurrentPromptError when a prior entry exists', async () => {
    markPromptInFlight(PROJECT_ID, lane('loopC'), 'sess-prior', 'code')
    const logger = createMockLogger()
    await expect(
      withInFlightGuard(PROJECT_ID, lane('loopC'), 'sess-new', 'auditor-loop', logger, async () => 'value')
    ).rejects.toBeInstanceOf(ConcurrentPromptError)
    const entry = getPromptInFlight(PROJECT_ID, lane('loopC'))
    expect(entry).toBeDefined()
    expect(entry!.sessionId).toBe('sess-prior')
    expect(entry!.agent).toBe('code')
  })

  test('clears in-flight when fn throws', async () => {
    const logger = createMockLogger()
    await expect(
      withInFlightGuard(PROJECT_ID, lane('loopD'), 'sess-3', 'auditor-loop', logger, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(getPromptInFlight(PROJECT_ID, lane('loopD'))).toBeUndefined()
  })

  test('does not clear in-flight if a different owner replaced it mid-flight', async () => {
    const logger = createMockLogger()
    await withInFlightGuard(PROJECT_ID, lane('loopE'), 'sess-4', 'code', logger, async () => {
      markPromptInFlight(PROJECT_ID, lane('loopE'), 'other-sess', 'auditor-loop')
    })
    const entry = getPromptInFlight(PROJECT_ID, lane('loopE'))
    expect(entry).toBeDefined()
    expect(entry!.sessionId).toBe('other-sess')
    expect(entry!.agent).toBe('auditor-loop')
  })
})
