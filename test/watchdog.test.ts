import { describe, it, expect } from 'vitest'
import { createLoopWatchdog } from '../src/hooks/watchdog'
import type { LoopState } from '../src/loop/state'
import { createFakeForgeClient } from './helpers/fake-client'

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
    status: 'running',
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

function createMockLoopService(overrides?: {
  getActiveState?: () => LoopState | null
  resolveLoopName?: (sessionId: string) => string | null
}) {
  return {
    getActiveState: overrides?.getActiveState ?? (() => getState()),
    getStallTimeoutMs: () => 10,
    getMaxConsecutiveStalls: () => 3,
    resolveLoopName: overrides?.resolveLoopName ?? ((sessionId: string) =>
      sessionId === 'coding-session' || sessionId === 'audit-session' ? 'test-loop' : null),
  }

  function getState(): LoopState {
    return createState()
  }
}

function createMockClient(statusImpl: () => Promise<any>) {
  return createFakeForgeClient({ session: { status: statusImpl } }).client
}

describe('createLoopWatchdog', () => {
  it('resets while current session remains busy', async () => {
    const stateRef = { current: createState() }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'busy', message: 'working' } })),
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

  it('treats busy child/subagent sessions as loop being busy', async () => {
    const stateRef = { current: createState({ sessionId: 'coding-session' }) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'idle' },
        'audit-session': { type: 'busy' },
      })),
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

    // Both sessions belong to 'test-loop' -> audit being busy counts as loop busy
    expect(recoverCalls.length).toBe(0)
    expect(terminateCalls.length).toBe(0)
    expect(watchdog.getStallInfo(loopName)?.consecutiveStalls).toBe(0)

    watchdog.stop(loopName)
  })

  it('does NOT treat busy session from another loop as this loop being busy', async () => {
    const stateRef = { current: createState({ sessionId: 'coding-session' }) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          resolveLoopName: (sessionId) =>
            sessionId === 'coding-session' ? 'test-loop' : null,
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'idle' },
        'unrelated-session': { type: 'busy' },
      })),
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

    // unrelated-session belongs to no loop -> this loop should stall
    expect(recoverCalls.length).toBeGreaterThanOrEqual(1)
    expect((recoverCalls[recoverCalls.length - 1] as { reason: string }).reason).toBe('non_busy_status')

    watchdog.stop(loopName)
  })

  it('resets activity for generic retry without usage-limit message', async () => {
    const stateRef = { current: createState() }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'retry', message: 'retrying request', attempt: 1, next: 1000 },
      })),
      logger,
      recover: async (ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
      },
    })

    const loopName = 'test-loop'
    watchdog.start(loopName)
    await wait(70)

    expect(recoverCalls.length).toBe(0)
    expect(terminateCalls.length).toBe(0)
    expect(watchdog.getStallInfo(loopName)?.consecutiveStalls).toBe(0)

    watchdog.stop(loopName)
  })

  it('terminates with provider_limit when retry snapshot has usage-limit message', async () => {
    const stateRef = { current: createState() }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'retry', attempt: 3, message: 'usage limit reached' },
      })),
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

    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toEqual({
      kind: 'provider_limit',
      message: expect.stringContaining('usage limit'),
    })
    expect(recoverCalls.length).toBe(0)

    watchdog.stop(loopName)
  })

  it('terminates with fresh state (not stale snapshot) when usage limit detected', async () => {
    // Start with an old state, then swap to a new state before terminate is called.
    const oldState = createState({ sessionId: 'old-session' })
    const newState = createState({ sessionId: 'new-session' })
    const terminateCalls: unknown[] = []
    const terminateStates: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        ...createMockLoopService({
          getActiveState: () => newState, // Always returns the new state
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'retry', attempt: 1, message: 'usage limit reached' },
      })),
      logger,
      recover: async () => {},
      terminate: async (_ln, state, reason) => {
        terminateCalls.push(reason)
        terminateStates.push(state)
        watchdog.stop(loopName)
      },
    })

    const loopName = 'test-loop'
    watchdog.start(loopName)
    await wait(60)

    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toEqual({
      kind: 'provider_limit',
      message: expect.stringContaining('usage limit'),
    })
    // The terminate callback should receive the fresh state, not the stale one
    expect(terminateStates[0]).toBe(newState)

    watchdog.stop(loopName)
  })

  it('does not terminate when active state becomes null during async status poll', async () => {
    // Simulate the race: state is active when the poll starts, but becomes
    // inactive (cancelled/restarted) before the terminate call.
    let stateActive = true
    const getState = () => stateActive ? createState() : null
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        ...createMockLoopService({
          getActiveState: getState,
        }),
      },
      client: createMockClient(async () => {
        // Flip the state to inactive during the async status poll
        stateActive = false
        return {
          'coding-session': { type: 'retry', attempt: 1, message: 'usage limit reached' },
        }
      }),
      logger,
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (_ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(loopName)
      },
    })

    const loopName = 'test-loop'
    watchdog.start(loopName)
    await wait(60)

    // The watchdog should NOT terminate because the fresh-state check returned null
    expect(terminateCalls.length).toBe(0)
    expect(recoverCalls.length).toBe(0)

    watchdog.stop(loopName)
  })

  it('treats generic retry snapshot as activity (no stall, no recover)', async () => {
    const stateRef = { current: createState() }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'retry', message: 'overloaded, retrying' },
      })),
      logger,
      recover: async (ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
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

  it('records status API failures and recovers before stall timeout', async () => {
    const stateRef = { current: createState() }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => {
        throw new Error('status api down')
      }),
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
    expect(terminateCalls[0]).toEqual({ kind: 'stall_timeout' })

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
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => {
        throw ''
      }),
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
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'idle' } })),
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

  it('terminates when child session has provider-limit retry via resolveSessionLoopName', async () => {
    const stateRef = { current: createState() }
    const terminateCalls: unknown[] = []

    const logger = createLogger()
    const watchdog = createLoopWatchdog({
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          // Main session resolves normally; child session does NOT resolve via DB
          resolveLoopName: (sid: string) =>
            sid === 'coding-session' ? 'test-loop' : null,
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'busy', message: 'working' },
        'child-session': { type: 'retry', attempt: 1, message: 'usage limit reached' },
      })),
      logger,
      recover: async () => {},
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(ln)
      },
      // Ancestor-aware resolver: child session's parent is the coding session
      resolveSessionLoopName: async (sid: string) => {
        if (sid === 'coding-session') return 'test-loop'
        if (sid === 'child-session') return 'test-loop'
        return null
      },
    })

    const loopName = 'test-loop'
    watchdog.start(loopName)
    await wait(60)

    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toEqual({
      kind: 'provider_limit',
      message: expect.stringContaining('usage limit'),
    })

    watchdog.stop(loopName)
  })
})
