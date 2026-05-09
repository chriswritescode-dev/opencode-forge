import { describe, it, expect } from 'bun:test'
import { createLoopWatchdog } from '../src/hooks/watchdog'
import type { LoopState } from '../src/services/loop'

function createState(overrides?: Partial<LoopState>): LoopState {
  return {
    active: true,
    sessionId: 'coding-session',
    loopName: 'test-loop',
    worktreeDir: '/tmp/test-worktree',
    iteration: 1,
    maxIterations: 0,
    startedAt: new Date().toISOString(),
    phase: 'coding',
    errorCount: 0,
    auditCount: 0,
    decompositionStatus: 'skipped',
    decompositionMode: 'deterministic',
    decompositionSessionId: null,
    currentSectionIndex: 0,
    totalSections: 0,
    finalAuditDone: false,
    ...overrides,
  }
}

function createLogger() {
  const logs: { level: 'log' | 'error' | 'debug'; message: string; args: unknown[] }[] = []
  return {
    log: (message: string, ...args: unknown[]) => logs.push({ level: 'log', message, args }),
    error: (message: string, ...args: unknown[]) => logs.push({ level: 'error', message, args }),
    debug: (message: string, ...args: unknown[]) => logs.push({ level: 'debug', message, args }),
    logs,
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('createLoopWatchdog', () => {
  it('resets while current session remains busy', async () => {
    const stateRef = { current: createState() }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        getActiveState: () => stateRef.current,
        getStallTimeoutMs: () => 10,
        getMaxConsecutiveStalls: () => 3,
      },
      v2Client: {
        session: {
          status: async () => ({
            data: { 'coding-session': { type: 'busy', message: 'working' } },
          }),
        },
      },
      logger,
      recover: async (ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(ln)
      },
    })

    const loopName = 'test-loop'
    watchdog.start(loopName)
    await wait(60)

    expect(recoverCalls.length).toBe(0)
    expect(terminateCalls.length).toBe(0)
    expect(watchdog.getStallInfo(loopName)?.consecutiveStalls).toBe(0)

    watchdog.stop(loopName)
  })

  it('uses current session only when deciding busy activity', async () => {
    const stateRef = { current: createState({ sessionId: 'coding-session' }) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        getActiveState: () => stateRef.current,
        getStallTimeoutMs: () => 10,
        getMaxConsecutiveStalls: () => 3,
      },
      v2Client: {
        session: {
          status: async () => ({
            data: {
              'coding-session': { type: 'idle' },
              'audit-session': { type: 'busy' },
            },
          }),
        },
      },
      logger,
      recover: async (ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(ln)
      },
    })

    const loopName = 'test-loop'
    watchdog.start(loopName)
    await wait(70)

    expect(recoverCalls.length).toBeGreaterThanOrEqual(1)
    expect((recoverCalls[recoverCalls.length - 1] as { reason: string }).reason).toBe('non_busy_status')
    expect(terminateCalls.length).toBe(1)

    watchdog.stop(loopName)
  })

  it('recovers for unchanged retry status before terminating at threshold', async () => {
    const stateRef = { current: createState() }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        getActiveState: () => stateRef.current,
        getStallTimeoutMs: () => 10,
        getMaxConsecutiveStalls: () => 3,
      },
      v2Client: {
        session: {
          status: async () => ({
            data: { 'coding-session': { type: 'retry', message: 'retrying request' } },
          }),
        },
      },
      logger,
      recover: async (ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(ln)
      },
    })

    const loopName = 'test-loop'
    watchdog.start(loopName)
    await wait(70)

    expect(recoverCalls.length).toBeGreaterThanOrEqual(2)
    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toBe('stall_timeout')
    const lastRecovery = recoverCalls[recoverCalls.length - 1] as { reason: string; status: string }
    expect(lastRecovery.reason).toBe('non_busy_status')
    expect(lastRecovery.status).toBe('retry')

    watchdog.stop(loopName)
  })

  it('records status API failures and recovers before stall timeout', async () => {
    const stateRef = { current: createState() }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        getActiveState: () => stateRef.current,
        getStallTimeoutMs: () => 10,
        getMaxConsecutiveStalls: () => 3,
      },
      v2Client: {
        session: {
          status: async () => {
            throw new Error('status api down')
          },
        },
      },
      logger,
      statusRetryAttempts: 1,
      statusRetryBackoffMs: 1,
      recover: async (ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(ln)
      },
    })

    const loopName = 'test-loop'
    watchdog.start(loopName)
    await wait(70)

    expect(recoverCalls.length).toBeGreaterThanOrEqual(2)
    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toBe('stall_timeout')

    const lastRecovery = recoverCalls[recoverCalls.length - 1] as { reason: string; error: unknown }
    expect(lastRecovery.reason).toBe('status_error')
    expect((lastRecovery.error as Error).message).toBe('status api down')

    const errorLogs = logger.logs.filter((l) => l.level === 'error' && l.message.includes('failed to check session status after retries'))
    expect(errorLogs.length).toBeGreaterThan(0)

    watchdog.stop(loopName)
  })

  it('records falsy status API failures', async () => {
    const stateRef = { current: createState() }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        getActiveState: () => stateRef.current,
        getStallTimeoutMs: () => 10,
        getMaxConsecutiveStalls: () => 3,
      },
      v2Client: {
        session: {
          status: async () => {
            throw ''
          },
        },
      },
      logger,
      statusRetryAttempts: 1,
      statusRetryBackoffMs: 1,
      recover: async (ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(ln)
      },
    })

    const loopName = 'test-loop'
    watchdog.start(loopName)
    await wait(25)

    expect(watchdog.getStallInfo(loopName)?.lastReason).toBe('status_error')
    expect(typeof watchdog.getStallInfo(loopName)?.lastError).toBe('string')

    watchdog.stop(loopName)
  })

  it('recordActivity resets stall count and clears reason', async () => {
    const stateRef = { current: createState() }
    const recoverCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        getActiveState: () => stateRef.current,
        getStallTimeoutMs: () => 10,
        getMaxConsecutiveStalls: () => 3,
      },
      v2Client: {
        session: {
          status: async () => ({
            data: { 'coding-session': { type: 'idle' } },
          }),
        },
      },
      logger,
      recover: async (ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async () => {},
    })

    const loopName = 'test-loop'
    watchdog.start(loopName)
    await wait(25)

    expect(watchdog.getStallInfo(loopName)?.consecutiveStalls).toBeGreaterThan(0)

    watchdog.recordActivity(loopName, 'tool-before:edit')
    expect(watchdog.getStallInfo(loopName)?.consecutiveStalls).toBe(0)
    expect(watchdog.getStallInfo(loopName)?.lastReason).toBeUndefined()

    watchdog.stop(loopName)
  })
})
