import { describe, test, expect, beforeEach } from 'vitest'
import {
  markPromptInFlight,
  clearPromptInFlight,
  assertNoPromptInFlight,
  getPromptInFlight,
  withInFlightGuard,
  ConcurrentPromptError,
  __resetInFlightGuard,
} from '../../src/loop/in-flight-guard'
import type { Logger } from '../../src/types'
import type { PromptAgent } from '../../src/loop/in-flight-guard'

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

describe('withInFlightGuard', () => {
  const loopName = 'L'
  const sessionId = 'S'
  const agent: PromptAgent = 'code'

  let logger: Logger

  beforeEach(() => {
    __resetInFlightGuard()
    logger = createMockLogger().logger
  })

  test('marks entry before invoking body and body sees it populated', async () => {
    const result = await withInFlightGuard(
      { loopName, sessionId, agent, logger },
      async () => {
        const entry = getPromptInFlight(loopName)
        return entry
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toBeDefined()
    expect(result.value!.sessionId).toBe(sessionId)
    expect(result.value!.agent).toBe(agent)
  })

  test('does NOT clear entry on success (busy handler clears)', async () => {
    await withInFlightGuard(
      { loopName, sessionId, agent, logger },
      async () => ({ answer: 42 }),
    )
    expect(getPromptInFlight(loopName)).toBeDefined()
    expect(getPromptInFlight(loopName)!.sessionId).toBe(sessionId)
  })

  test('clears entry on thrown error from body', async () => {
    try {
      await withInFlightGuard(
        { loopName, sessionId, agent, logger },
        async () => { throw new Error('boom') },
      )
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as Error).message).toBe('boom')
    }
    expect(getPromptInFlight(loopName)).toBeUndefined()
  })

  test('returns { ok: false, error: ConcurrentPromptError } when prior entry exists for different session', async () => {
    markPromptInFlight(loopName, 'other-session', 'auditor-loop')

    const bodyFn = async () => { throw new Error('should not run') }
    const out = await withInFlightGuard(
      { loopName, sessionId, agent, logger },
      bodyFn,
    )

    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected ok:false')
    expect(out.error).toBeInstanceOf(ConcurrentPromptError)

    const priorEntry = getPromptInFlight(loopName)!
    expect(priorEntry.sessionId).toBe('other-session')
    expect(priorEntry.agent).toBe('auditor-loop')
  })

  test('returns { ok: true, value } when body returns a value', async () => {
    const out = await withInFlightGuard(
      { loopName, sessionId, agent, logger },
      async () => ({ error: undefined as unknown }),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected ok:true')
    expect(out.value).toEqual({ error: undefined })
  })
})
