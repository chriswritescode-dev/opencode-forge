import { describe, test, expect, beforeEach } from 'vitest'
import {
  markPromptInFlight,
  clearPromptInFlight,
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
})
