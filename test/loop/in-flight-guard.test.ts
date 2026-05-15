import { describe, test, expect, beforeEach } from 'vitest'
import {
  markPromptInFlight,
  clearPromptInFlight,
  clearPromptInFlightIfMatches,
  assertNoPromptInFlight,
  getPromptInFlight,
  ConcurrentPromptError,
  __resetInFlightGuard,
} from '../../src/loop/in-flight-guard'
import type { Logger } from '../../src/types'

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
    markPromptInFlight('loopA', 'sess-1', 'code')
    const { logger, errorCalls } = createMockLogger()

    expect(() =>
      assertNoPromptInFlight('loopA', 'sess-2', 'auditor-loop', logger)
    ).toThrow(ConcurrentPromptError)

    expect(errorCalls.length).toBe(1)
    expect(errorCalls[0][0]).toContain('concurrent prompt rejected')
    expect(errorCalls[0][0]).toContain('loopA')
    expect(errorCalls[0][0]).toContain('sess-1')
    expect(errorCalls[0][0]).toContain('sess-2')
  })

  test('assertNoPromptInFlight returns without throwing after clear', () => {
    markPromptInFlight('loopA', 'sess-1', 'code')
    clearPromptInFlight('loopA')

    const { logger } = createMockLogger()
    expect(() =>
      assertNoPromptInFlight('loopA', 'sess-2', 'auditor-loop', logger)
    ).not.toThrow()
  })

  test('guards are per-loop (different loops are independent)', () => {
    markPromptInFlight('loopB', 'sess-3', 'code')

    const { logger } = createMockLogger()
    expect(() =>
      assertNoPromptInFlight('loopA', 'sess-4', 'auditor-loop', logger)
    ).not.toThrow()
  })

  test('rejects concurrent prompt for same loop with same session and agent', () => {
    markPromptInFlight('loopD', 'sess-7', 'auditor-loop')
    const { logger, errorCalls } = createMockLogger()

    expect(() =>
      assertNoPromptInFlight('loopD', 'sess-7', 'auditor-loop', logger)
    ).toThrow(ConcurrentPromptError)

    expect(errorCalls.length).toBe(1)
    const msg = errorCalls[0][0] as string
    expect(msg).toContain('[in-flight-guard]')
    expect(msg).toContain('loop=loopD')
    expect(msg).toContain('prior=auditor-loop: sess-7')
    expect(msg).toContain('attempted=auditor-loop: sess-7')
  })

  test('logger.error is called exactly once with correct details before throwing', () => {
    markPromptInFlight('loopC', 'sess-5', 'decomposer')
    const { logger, errorCalls } = createMockLogger()

    try {
      assertNoPromptInFlight('loopC', 'sess-6', 'code', logger)
      expect.fail('should have thrown')
    } catch {
      // expected
    }

    expect(errorCalls.length).toBe(1)
    const msg = errorCalls[0][0] as string
    expect(msg).toContain('[in-flight-guard]')
    expect(msg).toContain('loop=loopC')
    expect(msg).toContain('prior=decomposer: sess-5')
    expect(msg).toContain('attempted=code: sess-6')
  })

  test('clearPromptInFlightIfMatches clears matching owner', () => {
    markPromptInFlight('loopE', 'sess-9', 'code')
    const result = clearPromptInFlightIfMatches('loopE', 'sess-9', 'code')
    expect(result).toBe(true)
    expect(getPromptInFlight('loopE')).toBeUndefined()
  })

  test('clearPromptInFlightIfMatches preserves non-matching owner', () => {
    markPromptInFlight('loopF', 'sess-10', 'auditor-loop')
    const result = clearPromptInFlightIfMatches('loopF', 'sess-10', 'code')
    expect(result).toBe(false)
    expect(getPromptInFlight('loopF')).toBeDefined()
    expect(getPromptInFlight('loopF')!.sessionId).toBe('sess-10')
    expect(getPromptInFlight('loopF')!.agent).toBe('auditor-loop')
  })
})
