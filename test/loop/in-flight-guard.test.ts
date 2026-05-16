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
    markPromptInFlight('loopC', 'sess-5', 'auditor-loop')
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
    expect(msg).toContain('prior=auditor-loop: sess-5')
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

describe('clearPromptInFlightBySession', () => {
  beforeEach(() => {
    __resetInFlightGuard()
  })

  test('clears entry when session matches (any agent)', () => {
    markPromptInFlight('loopX', 'sess-A', 'auditor-loop')
    const result = clearPromptInFlightBySession('loopX', 'sess-A')
    expect(result).toBe(true)
    expect(getPromptInFlight('loopX')).toBeUndefined()
  })

  test('preserves entry when session differs', () => {
    markPromptInFlight('loopY', 'sess-A', 'code')
    const result = clearPromptInFlightBySession('loopY', 'sess-B')
    expect(result).toBe(false)
    expect(getPromptInFlight('loopY')).toBeDefined()
    expect(getPromptInFlight('loopY')!.sessionId).toBe('sess-A')
  })

  test('returns false when no entry exists', () => {
    const result = clearPromptInFlightBySession('loopZ', 'sess-A')
    expect(result).toBe(false)
  })
})

describe('withInFlightGuard', () => {
  beforeEach(() => {
    __resetInFlightGuard()
  })

  test('passes through return value when no concurrent prompt is in-flight', async () => {
    const { logger } = createMockLogger()
    const result = await withInFlightGuard('loopA', 'sess-1', 'code', logger, async () => ({ data: 'ok' }))
    expect(result).toEqual({ data: 'ok' })
    expect(getPromptInFlight('loopA')).toBeUndefined()
  })

  test('marks in-flight while fn runs, clears after', async () => {
    const { logger } = createMockLogger()
    let duringEntry: ReturnType<typeof getPromptInFlight> = undefined
    await withInFlightGuard('loopB', 'sess-2', 'auditor-loop', logger, async () => {
      duringEntry = getPromptInFlight('loopB')
      return 'done'
    })
    expect(duringEntry).toBeDefined()
    expect(duringEntry!.sessionId).toBe('sess-2')
    expect(duringEntry!.agent).toBe('auditor-loop')
    expect(getPromptInFlight('loopB')).toBeUndefined()
  })

  test('throws ConcurrentPromptError when a prior entry exists', async () => {
    markPromptInFlight('loopC', 'sess-prior', 'code')
    const { logger } = createMockLogger()
    await expect(
      withInFlightGuard('loopC', 'sess-new', 'auditor-loop', logger, async () => 'value')
    ).rejects.toBeInstanceOf(ConcurrentPromptError)
    const entry = getPromptInFlight('loopC')
    expect(entry).toBeDefined()
    expect(entry!.sessionId).toBe('sess-prior')
    expect(entry!.agent).toBe('code')
  })

  test('clears in-flight when fn throws', async () => {
    const { logger } = createMockLogger()
    await expect(
      withInFlightGuard('loopD', 'sess-3', 'auditor-loop', logger, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(getPromptInFlight('loopD')).toBeUndefined()
  })

  test('does not clear in-flight if a different owner replaced it mid-flight', async () => {
    const { logger } = createMockLogger()
    await withInFlightGuard('loopE', 'sess-4', 'code', logger, async () => {
      markPromptInFlight('loopE', 'other-sess', 'auditor-loop')
    })
    const entry = getPromptInFlight('loopE')
    expect(entry).toBeDefined()
    expect(entry!.sessionId).toBe('other-sess')
    expect(entry!.agent).toBe('auditor-loop')
  })
})
