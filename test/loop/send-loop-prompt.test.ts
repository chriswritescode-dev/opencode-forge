import { describe, test, expect, beforeEach, vi } from 'vitest'
import {
  markPromptInFlight,
  __resetInFlightGuard,
  ConcurrentPromptError,
  type PromptAgent,
} from '../../src/loop/in-flight-guard'
import type { Logger } from '../../src/types'

const { clearPromptPendingMock, markPromptSentMock } = vi.hoisted(() => ({
  clearPromptPendingMock: vi.fn(),
  markPromptSentMock: vi.fn(),
}))

vi.mock('../../src/loop/idle-gate', () => ({
  clearPromptPending: clearPromptPendingMock,
  markPromptSent: markPromptSentMock,
  sessionsAwaitingBusy: new Map(),
  AWAITING_BUSY_TIMEOUT_MS: 10000,
  isAwaitingBusy: vi.fn(),
  isAwaitingBusyExpired: vi.fn(),
}))

import { sendLoopPrompt } from '../../src/loop/send-loop-prompt'

function createMockLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

const testModel = { providerID: 'test-provider', modelID: 'test-model' }
const loopName = 'test-loop'
const sessionId = 'test-session'
const agent: PromptAgent = 'code'

describe('sendLoopPrompt', () => {
  beforeEach(() => {
    __resetInFlightGuard()
    clearPromptPendingMock.mockClear()
    markPromptSentMock.mockClear()
  })

  test('success with model', async () => {
    const performPrompt = vi.fn().mockResolvedValue({})

    const result = await sendLoopPrompt({
      loopName,
      sessionId,
      agent,
      logger: createMockLogger(),
      primaryModel: testModel,
      performPrompt,
    })

    expect(result.result.error).toBeUndefined()
    expect(result.usedModel).toEqual(testModel)
    expect(performPrompt).toHaveBeenCalledTimes(1)
    expect(performPrompt).toHaveBeenCalledWith(testModel)
    expect(clearPromptPendingMock).not.toHaveBeenCalled()
  })

  test('model fallback', async () => {
    const performPrompt = vi.fn((model: typeof testModel | undefined) => {
      if (model) return { error: new Error('model failed') }
      return {}
    })

    const result = await sendLoopPrompt({
      loopName,
      sessionId,
      agent,
      logger: createMockLogger(),
      primaryModel: testModel,
      performPrompt,
    })

    expect(result.result.error).toBeUndefined()
    expect(result.usedModel).toBeUndefined()
    expect(performPrompt).toHaveBeenCalledTimes(3)
    expect(performPrompt).toHaveBeenNthCalledWith(1, testModel)
    expect(performPrompt).toHaveBeenNthCalledWith(2, testModel)
    expect(performPrompt).toHaveBeenNthCalledWith(3, undefined)
  })

  test('error clears pending (default)', async () => {
    const testError = new Error('provider failure')
    const performPrompt = vi.fn().mockResolvedValue({ error: testError })

    const result = await sendLoopPrompt({
      loopName,
      sessionId,
      agent,
      logger: createMockLogger(),
      primaryModel: null,
      performPrompt,
    })

    expect(result.result.error).toBe(testError)
    expect(clearPromptPendingMock).toHaveBeenCalledTimes(1)
    expect(clearPromptPendingMock).toHaveBeenCalledWith(loopName, expect.anything())
  })

  test('clearPendingOnError: false', async () => {
    const testError = new Error('provider failure')
    const performPrompt = vi.fn().mockResolvedValue({ error: testError })

    const result = await sendLoopPrompt({
      loopName,
      sessionId,
      agent,
      logger: createMockLogger(),
      primaryModel: null,
      performPrompt,
      clearPendingOnError: false,
    })

    expect(result.result.error).toBe(testError)
    expect(clearPromptPendingMock).not.toHaveBeenCalled()
  })

  test('in-flight guard rejects concurrent', async () => {
    const performPrompt = vi.fn()
    markPromptInFlight(loopName, 'other-session', agent)

    const result = await sendLoopPrompt({
      loopName,
      sessionId,
      agent,
      logger: createMockLogger(),
      primaryModel: testModel,
      performPrompt,
    })

    expect(result.result.error).toBeInstanceOf(ConcurrentPromptError)
    expect(clearPromptPendingMock).not.toHaveBeenCalled()
    expect(performPrompt).not.toHaveBeenCalled()
  })

  test('useInFlightGuard: false allows concurrent', async () => {
    const performPrompt = vi.fn().mockResolvedValue({})
    markPromptInFlight(loopName, 'other-session', agent)

    const result = await sendLoopPrompt({
      loopName,
      sessionId,
      agent,
      logger: createMockLogger(),
      primaryModel: testModel,
      performPrompt,
      useInFlightGuard: false,
    })

    expect(result.result.error).toBeUndefined()
    expect(performPrompt).toHaveBeenCalledTimes(1)
  })
})
