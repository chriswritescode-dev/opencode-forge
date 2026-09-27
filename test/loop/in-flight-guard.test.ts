import { describe, test, expect, beforeEach } from 'vitest'
import {
  markPromptInFlight,
  clearPromptInFlight,
  clearPromptInFlightIfMatches,
  clearPromptInFlightBySession,
  withInFlightGuard,
  assertNoPromptInFlight,
  getPromptInFlight,
  ConcurrentPromptError,
  __resetInFlightGuard,
} from '../../src/loop/in-flight-guard'
import type { Logger } from '../../src/types'

const PROJECT_ID = 'test-project'

function createMockLogger(): { logger: Logger; errorCalls: unknown[][] } {
  const errorCalls: unknown[][] = []
  const logger: Logger = {
    log: () => {},
    error: (...args: unknown[]) => errorCalls.push(args),
    debug: () => {},
  }
  return { logger, errorCalls }
}

describe('in-flight guard', () => {
  beforeEach(() => {
    __resetInFlightGuard()
  })

  test('rejects concurrent prompt for same loop with different session/agent', () => {
    markPromptInFlight(PROJECT_ID, 'loopA', 'sess-1', 'code')
    const { logger, errorCalls } = createMockLogger()

    expect(() =>
      assertNoPromptInFlight(PROJECT_ID, 'loopA', 'sess-2', 'auditor-loop', logger)
    ).toThrow(ConcurrentPromptError)

    expect(errorCalls.length).toBe(1)
    expect(errorCalls[0][0]).toContain('concurrent prompt rejected')
    expect(errorCalls[0][0]).toContain('loopA')
    expect(errorCalls[0][0]).toContain('sess-1')
    expect(errorCalls[0][0]).toContain('sess-2')
  })

  test('assertNoPromptInFlight returns without throwing after clear', () => {
    markPromptInFlight(PROJECT_ID, 'loopA', 'sess-1', 'code')
    clearPromptInFlight(PROJECT_ID, 'loopA')

    const { logger } = createMockLogger()
    expect(() =>
      assertNoPromptInFlight(PROJECT_ID, 'loopA', 'sess-2', 'auditor-loop', logger)
    ).not.toThrow()
  })

  test('guards are per-loop (different loops are independent)', () => {
    markPromptInFlight(PROJECT_ID, 'loopB', 'sess-3', 'code')

    const { logger } = createMockLogger()
    expect(() =>
      assertNoPromptInFlight(PROJECT_ID, 'loopA', 'sess-4', 'auditor-loop', logger)
    ).not.toThrow()
  })

  test('rejects concurrent prompt for same loop with same session and agent', () => {
    markPromptInFlight(PROJECT_ID, 'loopD', 'sess-7', 'auditor-loop')
    const { logger, errorCalls } = createMockLogger()

    expect(() =>
      assertNoPromptInFlight(PROJECT_ID, 'loopD', 'sess-7', 'auditor-loop', logger)
    ).toThrow(ConcurrentPromptError)

    expect(errorCalls.length).toBe(1)
    const msg = errorCalls[0][0] as string
    expect(msg).toContain('[in-flight-guard]')
    expect(msg).toContain('loop=loopD')
    expect(msg).toContain('prior=auditor-loop: sess-7')
    expect(msg).toContain('attempted=auditor-loop: sess-7')
  })

  test('logger.error is called exactly once with correct details before throwing', () => {
    markPromptInFlight(PROJECT_ID, 'loopC', 'sess-5', 'auditor-loop')
    const { logger, errorCalls } = createMockLogger()

    try {
      assertNoPromptInFlight(PROJECT_ID, 'loopC', 'sess-6', 'code', logger)
      expect.fail('should have thrown')
    } catch {
      // expected
    }

    expect(errorCalls.length).toBe(1)
    const msg = errorCalls[0][0] as string
    expect(msg).toContain('[in-flight-guard]')
    expect(msg).toContain('loop=loopC')
    expect(msg).toContain('prior=auditor-loop: sess-5')
    expect(msg).toContain('attempted=code: sess-6')
  })

  test('clearPromptInFlightIfMatches clears matching owner', () => {
    markPromptInFlight(PROJECT_ID, 'loopE', 'sess-9', 'code')
    const result = clearPromptInFlightIfMatches(PROJECT_ID, 'loopE', 'sess-9', 'code')
    expect(result).toBe(true)
    expect(getPromptInFlight(PROJECT_ID, 'loopE')).toBeUndefined()
  })

  test('clearPromptInFlightIfMatches preserves non-matching owner', () => {
    markPromptInFlight(PROJECT_ID, 'loopF', 'sess-10', 'auditor-loop')
    const result = clearPromptInFlightIfMatches(PROJECT_ID, 'loopF', 'sess-10', 'code')
    expect(result).toBe(false)
    expect(getPromptInFlight(PROJECT_ID, 'loopF')).toBeDefined()
    expect(getPromptInFlight(PROJECT_ID, 'loopF')!.sessionId).toBe('sess-10')
    expect(getPromptInFlight(PROJECT_ID, 'loopF')!.agent).toBe('auditor-loop')
  })
})

describe('clearPromptInFlightBySession', () => {
  beforeEach(() => {
    __resetInFlightGuard()
  })

  test('clears entry when session matches (any agent)', () => {
    markPromptInFlight(PROJECT_ID, 'loopX', 'sess-A', 'auditor-loop')
    const result = clearPromptInFlightBySession(PROJECT_ID, 'loopX', 'sess-A')
    expect(result).toBe(true)
    expect(getPromptInFlight(PROJECT_ID, 'loopX')).toBeUndefined()
  })

  test('preserves entry when session differs', () => {
    markPromptInFlight(PROJECT_ID, 'loopY', 'sess-A', 'code')
    const result = clearPromptInFlightBySession(PROJECT_ID, 'loopY', 'sess-B')
    expect(result).toBe(false)
    expect(getPromptInFlight(PROJECT_ID, 'loopY')).toBeDefined()
    expect(getPromptInFlight(PROJECT_ID, 'loopY')!.sessionId).toBe('sess-A')
  })

  test('returns false when no entry exists', () => {
    const result = clearPromptInFlightBySession(PROJECT_ID, 'loopZ', 'sess-A')
    expect(result).toBe(false)
  })
})

describe('withInFlightGuard', () => {
  beforeEach(() => {
    __resetInFlightGuard()
  })

  test('passes through return value when no concurrent prompt is in-flight', async () => {
    const { logger } = createMockLogger()
    const result = await withInFlightGuard(PROJECT_ID, 'loopA', 'sess-1', 'code', logger, async () => 'ok')
    expect(result).toEqual('ok')
    expect(getPromptInFlight(PROJECT_ID, 'loopA')).toBeUndefined()
  })

  test('marks in-flight while fn runs, clears after', async () => {
    const { logger } = createMockLogger()
    let duringEntry: ReturnType<typeof getPromptInFlight> = undefined
    await withInFlightGuard(PROJECT_ID, 'loopB', 'sess-2', 'auditor-loop', logger, async () => {
      duringEntry = getPromptInFlight(PROJECT_ID, 'loopB')
      return 'done'
    })
    expect(duringEntry).toBeDefined()
    expect(duringEntry!.sessionId).toBe('sess-2')
    expect(duringEntry!.agent).toBe('auditor-loop')
    expect(getPromptInFlight(PROJECT_ID, 'loopB')).toBeUndefined()
  })

  test('throws ConcurrentPromptError when a prior entry exists', async () => {
    markPromptInFlight(PROJECT_ID, 'loopC', 'sess-prior', 'code')
    const { logger } = createMockLogger()
    await expect(
      withInFlightGuard(PROJECT_ID, 'loopC', 'sess-new', 'auditor-loop', logger, async () => 'value')
    ).rejects.toBeInstanceOf(ConcurrentPromptError)
    const entry = getPromptInFlight(PROJECT_ID, 'loopC')
    expect(entry).toBeDefined()
    expect(entry!.sessionId).toBe('sess-prior')
    expect(entry!.agent).toBe('code')
  })

  test('clears in-flight when fn throws', async () => {
    const { logger } = createMockLogger()
    await expect(
      withInFlightGuard(PROJECT_ID, 'loopD', 'sess-3', 'auditor-loop', logger, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(getPromptInFlight(PROJECT_ID, 'loopD')).toBeUndefined()
  })

  test('does not clear in-flight if a different owner replaced it mid-flight', async () => {
    const { logger } = createMockLogger()
    await withInFlightGuard(PROJECT_ID, 'loopE', 'sess-4', 'code', logger, async () => {
      markPromptInFlight(PROJECT_ID, 'loopE', 'other-sess', 'auditor-loop')
    })
    const entry = getPromptInFlight(PROJECT_ID, 'loopE')
    expect(entry).toBeDefined()
    expect(entry!.sessionId).toBe('other-sess')
    expect(entry!.agent).toBe('auditor-loop')
  })
})
