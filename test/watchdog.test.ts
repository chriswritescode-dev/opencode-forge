import { describe, it, expect, vi } from 'vitest'
import { createLoopWatchdog } from '../src/hooks/watchdog'
import type { LoopState } from '../src/loop/state'
import type { LoopLane } from '../src/loop/section-run'
import { createFakeForgeClient } from './helpers/fake-client'
import { makeLoopState } from './helpers/loop-fixtures'
import { createCapturingLogger } from './helpers/logger'

const WATCHDOG_STATE_DEFAULTS = {
  sessionId: 'coding-session',
  worktreeDir: '/tmp/test-worktree',
  maxIterations: 0,
}

const PLAN_LANE: LoopLane = { loopName: 'test-loop', sectionRunKey: 'plan' }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createMockLoopService(overrides?: {
  getActiveState?: () => LoopState | null
  getRunState?: (loopName: string, runKey: string) => LoopState | null
  isRunActive?: (lane: LoopLane) => boolean
  resolveLoopName?: (sessionId: string) => string | null
  getBusyStallTimeoutMs?: () => number
  getStallTimeoutMs?: () => number
}) {
  const getActiveState = overrides?.getActiveState ?? (() => makeLoopState(WATCHDOG_STATE_DEFAULTS))
  const getRunState = overrides?.getRunState ?? ((_loopName: string, _runKey: string) => getActiveState())
  return {
    getActiveState,
    getRunState,
    isRunActive: overrides?.isRunActive ?? (() => true),
    getStallTimeoutMs: overrides?.getStallTimeoutMs ?? (() => 10),
    getMaxConsecutiveStalls: () => 3,
    getBusyStallTimeoutMs: overrides?.getBusyStallTimeoutMs ?? (() => 900_000),
    resolveLoopName: overrides?.resolveLoopName ?? ((sessionId: string) =>
      sessionId === 'coding-session' || sessionId === 'audit-session' ? 'test-loop' : null),
  }
}

function createMockClient(statusImpl: () => Promise<any>) {
  return createFakeForgeClient({ session: { status: statusImpl } }).client
}

describe('createLoopWatchdog', () => {
  it('resets while current session remains busy', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'busy', message: 'working' } })),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(60)

    expect(recoverCalls.length).toBe(0)
    expect(terminateCalls.length).toBe(0)
    expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('reports whether a stall interval is running for a lane', () => {
    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: createMockLoopService(),
      client: createMockClient(async () => ({ 'coding-session': { type: 'busy' } })),
      logger,
      nudge: vi.fn(),
      recover: vi.fn(),
      terminate: vi.fn(),
    })

    expect(watchdog.isRunning(PLAN_LANE)).toBe(false)
    watchdog.start(PLAN_LANE)
    expect(watchdog.isRunning(PLAN_LANE)).toBe(true)
    watchdog.stop(PLAN_LANE)
    expect(watchdog.isRunning(PLAN_LANE)).toBe(false)
    watchdog.clearAll()
  })

  it('treats busy child/subagent sessions as loop being busy', async () => {
    const stateRef = { current: makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, sessionId: 'coding-session' }) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
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
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(60)

    // Both sessions belong to 'test-loop' -> audit being busy counts as loop busy
    expect(recoverCalls.length).toBe(0)
    expect(terminateCalls.length).toBe(0)
    expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('does NOT treat busy session from another loop as this loop being busy', async () => {
    const stateRef = { current: makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, sessionId: 'coding-session' }) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
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
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(70)

    // unrelated-session belongs to no loop -> this loop should stall
    expect(recoverCalls.length).toBeGreaterThanOrEqual(1)
    expect((recoverCalls[recoverCalls.length - 1] as { reason: string }).reason).toBe('non_busy_status')

    watchdog.stop(PLAN_LANE)
  })

  it('resets activity for generic retry without usage-limit message', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'retry', message: 'retrying request', attempt: 1, next: 1000 },
      })),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (_ln, _s, reason) => {
        terminateCalls.push(reason)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(70)

    expect(recoverCalls.length).toBe(0)
    expect(terminateCalls.length).toBe(0)
    expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('terminates with provider_limit when retry snapshot has usage-limit message', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'retry', attempt: 3, message: 'usage limit reached' },
      })),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(60)

    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toEqual({
      kind: 'provider_limit',
      message: expect.stringContaining('usage limit'),
    })
    expect(recoverCalls.length).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('terminates with fresh state (not stale snapshot) when usage limit detected', async () => {
    // The active state is the fresh one at terminate time.
    const newState = makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, sessionId: 'new-session' })
    const terminateCalls: unknown[] = []
    const terminateStates: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => newState, // Always returns the new state
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'retry', attempt: 1, message: 'usage limit reached' },
      })),
      logger,
      nudge: vi.fn(),
      recover: async () => {},
      terminate: async (_ln, state, reason) => {
        terminateCalls.push(reason)
        terminateStates.push(state)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(60)

    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toEqual({
      kind: 'provider_limit',
      message: expect.stringContaining('usage limit'),
    })
    // The terminate callback should receive the fresh state, not the stale one
    expect(terminateStates[0]).toBe(newState)

    watchdog.stop(PLAN_LANE)
  })

  it('does not terminate when active state becomes null during async status poll', async () => {
    // Simulate the race: state is active when the poll starts, but becomes
    // inactive (cancelled/restarted) before the terminate call.
    let stateActive = true
    const getState = () => stateActive ? makeLoopState(WATCHDOG_STATE_DEFAULTS) : null
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
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
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (_ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(60)

    // The watchdog should NOT terminate because the fresh-state check returned null
    expect(terminateCalls.length).toBe(0)
    expect(recoverCalls.length).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('treats generic retry snapshot as activity (no stall, no recover)', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'retry', message: 'overloaded, retrying' },
      })),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (_ln, _s, reason) => {
        terminateCalls.push(reason)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(60)

    expect(recoverCalls.length).toBe(0)
    expect(terminateCalls.length).toBe(0)
    expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('records status API failures and recovers before stall timeout', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger, logs } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
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
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(70)

    expect(recoverCalls.length).toBeGreaterThanOrEqual(2)
    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toEqual({ kind: 'stall_timeout' })

    const lastRecovery = recoverCalls[recoverCalls.length - 1] as { reason: string; error: unknown }
    expect(lastRecovery.reason).toBe('status_error')
    expect((lastRecovery.error as Error).message).toBe('status api down')

    const errorLogs = logs.filter((l) => l.level === 'error' && l.message.includes('failed to check session status after retries'))
    expect(errorLogs.length).toBeGreaterThan(0)

    watchdog.stop(PLAN_LANE)
  })

  it('records falsy status API failures', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
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
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(25)

    expect(watchdog.getStallInfo(PLAN_LANE)?.lastReason).toBe('status_error')
    expect(typeof watchdog.getStallInfo(PLAN_LANE)?.lastError).toBe('string')

    watchdog.stop(PLAN_LANE)
  })

  it('recordActivity resets stall count and clears reason', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'idle' } })),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async () => {},
    })

    watchdog.start(PLAN_LANE)
    await wait(25)

    expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBeGreaterThan(0)

    watchdog.recordActivity(PLAN_LANE, 'tool-before:edit')
    expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(0)
    expect(watchdog.getStallInfo(PLAN_LANE)?.lastReason).toBeUndefined()

    watchdog.stop(PLAN_LANE)
  })

  it('recordActivity checks run activity without loading the full run state', () => {
    const state = makeLoopState(WATCHDOG_STATE_DEFAULTS)
    const getRunState = vi.fn(() => state)
    const isRunActive = vi.fn(() => true)

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({ getRunState, isRunActive, getStallTimeoutMs: () => 60_000 }),
      },
      client: createMockClient(async () => ({})),
      logger,
      nudge: vi.fn(),
      recover: vi.fn(),
      terminate: vi.fn(),
    })

    watchdog.start(PLAN_LANE)
    expect(getRunState).not.toHaveBeenCalled()

    watchdog.recordActivity(PLAN_LANE, 'tool-before:edit')

    expect(isRunActive).toHaveBeenCalledWith(PLAN_LANE)
    expect(getRunState).not.toHaveBeenCalled()
    watchdog.stop(PLAN_LANE)
  })

  it('absorbs provider-limit retry in auditing when fallback returns true and resets activity', async () => {
    const stateRef = { current: makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, phase: 'auditing', sessionId: 'audit-session' }) }
    const terminateCalls: unknown[] = []
    const fallbackCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'audit-session': { type: 'retry', attempt: 1, message: 'usage limit reached' },
      })),
      logger,
      nudge: vi.fn(),
      recover: async () => {},
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
      handleAuditorProviderLimit: async (ln, reason) => {
        fallbackCalls.push({ ln, reason })
        return true
      },
    })

    const loopName = 'test-loop'
    watchdog.start(PLAN_LANE)
    await wait(60)

    expect(fallbackCalls.length).toBeGreaterThanOrEqual(1)
    expect((fallbackCalls[0] as { ln: string }).ln).toBe(loopName)
    expect(String((fallbackCalls[0] as { reason: unknown }).reason)).toContain('usage limit')
    expect(terminateCalls.length).toBe(0)
    expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('terminates with provider_limit in auditing when fallback returns false', async () => {
    const stateRef = { current: makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, phase: 'auditing', sessionId: 'audit-session' }) }
    const terminateCalls: unknown[] = []
    const fallbackCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'audit-session': { type: 'retry', attempt: 1, message: 'usage limit reached' },
      })),
      logger,
      nudge: vi.fn(),
      recover: async () => {},
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
      handleAuditorProviderLimit: async (ln, reason) => {
        fallbackCalls.push({ ln, reason })
        return false
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(60)

    expect(fallbackCalls.length).toBe(1)
    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toEqual({
      kind: 'provider_limit',
      message: expect.stringContaining('usage limit'),
    })

    watchdog.stop(PLAN_LANE)
  })

  it('terminates with provider_limit when fallback absent (backwards compatible)', async () => {
    const stateRef = { current: makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, phase: 'auditing', sessionId: 'audit-session' }) }
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'audit-session': { type: 'retry', attempt: 1, message: 'usage limit reached' },
      })),
      logger,
      nudge: vi.fn(),
      recover: async () => {},
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(60)

    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toEqual({
      kind: 'provider_limit',
      message: expect.stringContaining('usage limit'),
    })

    watchdog.stop(PLAN_LANE)
  })

  it('does not absorb provider-limit retry in a non-auditor phase', async () => {
    const stateRef = { current: makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, phase: 'coding' }) }
    const terminateCalls: unknown[] = []
    let fallbackCalls = 0

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({
        'coding-session': { type: 'retry', attempt: 1, message: 'usage limit reached' },
      })),
      logger,
      nudge: vi.fn(),
      recover: async () => {},
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
      handleAuditorProviderLimit: async () => {
        fallbackCalls += 1
        return true
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(60)

    expect(fallbackCalls).toBe(0)
    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toEqual({
      kind: 'provider_limit',
      message: expect.stringContaining('usage limit'),
    })

    watchdog.stop(PLAN_LANE)
  })

  it('terminates when child session has provider-limit retry via resolveSessionLoopName', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
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
      nudge: vi.fn(),
      recover: async () => {},
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
      // Ancestor-aware resolver: child session's parent is the coding session
      resolveSessionLoopName: async (sid: string) => {
        if (sid === 'coding-session') return 'test-loop'
        if (sid === 'child-session') return 'test-loop'
        return null
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(60)

    expect(terminateCalls.length).toBe(1)
    expect(terminateCalls[0]).toEqual({
      kind: 'provider_limit',
      message: expect.stringContaining('usage limit'),
    })

    watchdog.stop(PLAN_LANE)
  })

  it('nudges a session stuck busy with no activity past busyStallTimeoutMs', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const nudgeCalls: unknown[] = []
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getBusyStallTimeoutMs: () => 30,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'busy', message: 'working' } })),
      logger,
      nudge: async (ln, _s, ctx) => {
        nudgeCalls.push(ctx)
        watchdog.stop(PLAN_LANE)
      },
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(120)

    expect(nudgeCalls.length).toBe(1)
    expect(nudgeCalls[0]).toMatchObject({ reason: 'busy_no_progress', status: 'busy', stallCount: 1 })
    expect((nudgeCalls[0] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(30)
    expect(recoverCalls.length).toBe(0)
    expect(terminateCalls.length).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('does not nudge while busy stays under busyStallTimeoutMs', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const nudgeCalls: unknown[] = []
    const recoverCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getBusyStallTimeoutMs: () => 10_000,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'busy', message: 'working' } })),
      logger,
      nudge: async (_ln, _s, ctx) => {
        nudgeCalls.push(ctx)
      },
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async () => {},
    })

    watchdog.start(PLAN_LANE)
    await wait(120)

    expect(nudgeCalls.length).toBe(0)
    expect(recoverCalls.length).toBe(0)
    expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('recordActivity during a busy stretch resets the busy ceiling', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const nudgeCalls: unknown[] = []
    let recording = true

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getBusyStallTimeoutMs: () => 30,
        }),
      },
      client: createMockClient(async () => {
        if (recording) watchdog.recordActivity(PLAN_LANE, 'tool-after:edit')
        return { 'coding-session': { type: 'busy', message: 'working' } }
      }),
      logger,
      nudge: async (_ln, _s, ctx) => {
        nudgeCalls.push(ctx)
      },
      recover: async () => {},
      terminate: async () => {},
    })

    watchdog.start(PLAN_LANE)
    await wait(150)

    // Real tool activity kept resetting the ceiling, so the busy stretch never matured
    expect(nudgeCalls.length).toBe(0)

    // Once activity stops, the same busy stream does mature into a nudge
    recording = false
    await wait(150)
    expect(nudgeCalls.length).toBeGreaterThanOrEqual(1)

    watchdog.stop(PLAN_LANE)
  })

  it('streamed content (thinking) during a busy stretch resets the busy ceiling', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const nudgeCalls: unknown[] = []
    let streaming = true

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getBusyStallTimeoutMs: () => 30,
        }),
      },
      client: createMockClient(async () => {
        if (streaming) watchdog.recordSessionContent('coding-session')
        return { 'coding-session': { type: 'busy', message: 'thinking' } }
      }),
      logger,
      nudge: async (_ln, _s, ctx) => {
        nudgeCalls.push(ctx)
      },
      recover: async () => {},
      terminate: async () => {},
    })

    watchdog.start(PLAN_LANE)
    await wait(150)

    // Reasoning deltas emit no tool calls, but they prove the stream is alive
    expect(nudgeCalls.length).toBe(0)

    // Once the stream goes quiet, the busy stretch matures into a nudge
    streaming = false
    await wait(150)
    expect(nudgeCalls.length).toBeGreaterThanOrEqual(1)

    watchdog.stop(PLAN_LANE)
  })

  it('counts streamed content from a child session of the same loop', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const nudgeCalls: unknown[] = []
    let streaming = true

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getBusyStallTimeoutMs: () => 30,
        }),
      },
      client: createMockClient(async () => {
        if (streaming) watchdog.recordSessionContent('audit-session')
        return {
          'coding-session': { type: 'busy' },
          'audit-session': { type: 'busy' },
        }
      }),
      logger,
      nudge: async (_ln, _s, ctx) => {
        nudgeCalls.push(ctx)
      },
      recover: async () => {},
      terminate: async () => {},
    })

    watchdog.start(PLAN_LANE)
    await wait(150)

    // A thinking subagent keeps the whole loop alive
    expect(nudgeCalls.length).toBe(0)

    streaming = false
    await wait(150)
    expect(nudgeCalls.length).toBeGreaterThanOrEqual(1)

    watchdog.stop(PLAN_LANE)
  })

  it('honors a busyStallTimeoutMs lower than stallTimeoutMs instead of coarsening it', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const nudgeCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getBusyStallTimeoutMs: () => 20,
        }),
        // Deliberately coarser than the busy ceiling: polling must follow the finer of the two
        getStallTimeoutMs: () => 200,
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'busy' } })),
      logger,
      nudge: async (ln, _s, ctx) => {
        nudgeCalls.push(ctx)
        watchdog.stop(PLAN_LANE)
      },
      recover: async () => {},
      terminate: async () => {},
    })

    watchdog.start(PLAN_LANE)

    // Well under two stall timeouts: with stall-timeout-only polling this would still be 0
    await wait(320)

    expect(nudgeCalls.length).toBe(1)

    watchdog.stop(PLAN_LANE)
  })

  it('ignores streamed content from a session outside the loop', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const nudgeCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getBusyStallTimeoutMs: () => 30,
        }),
      },
      client: createMockClient(async () => {
        watchdog.recordSessionContent('unrelated-session')
        return { 'coding-session': { type: 'busy' } }
      }),
      logger,
      nudge: async (ln, _s, ctx) => {
        nudgeCalls.push(ctx)
        watchdog.stop(PLAN_LANE)
      },
      recover: async () => {},
      terminate: async () => {},
    })

    watchdog.start(PLAN_LANE)
    await wait(120)

    expect(nudgeCalls.length).toBe(1)

    watchdog.stop(PLAN_LANE)
  })

  it('disables nudging when busyStallTimeoutMs is 0', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const nudgeCalls: unknown[] = []
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getBusyStallTimeoutMs: () => 0,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'busy', message: 'working' } })),
      logger,
      nudge: async (_ln, _s, ctx) => {
        nudgeCalls.push(ctx)
      },
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(150)

    expect(nudgeCalls.length).toBe(0)
    expect(recoverCalls.length).toBe(0)
    expect(terminateCalls.length).toBe(0)
    expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('escalates repeated busy_no_progress stalls to termination', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const nudgeCalls: unknown[] = []
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getBusyStallTimeoutMs: () => 10,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'busy', message: 'working' } })),
      logger,
      nudge: async (_ln, _s, ctx) => {
        nudgeCalls.push(ctx)
      },
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (ln, _s, reason) => {
        terminateCalls.push(reason)
        watchdog.stop(PLAN_LANE)
      },
    })

    watchdog.start(PLAN_LANE)
    await wait(200)

    // maxConsecutiveStalls is 3: two nudges, then the third stall terminates
    expect(nudgeCalls.length).toBe(2)
    expect((nudgeCalls[0] as { stallCount: number }).stallCount).toBe(1)
    expect((nudgeCalls[1] as { stallCount: number }).stallCount).toBe(2)
    expect(recoverCalls.length).toBe(0)
    expect(terminateCalls).toEqual([{ kind: 'stall_timeout' }])

    watchdog.stop(PLAN_LANE)
  })

  it('does not count a stall while the current session has a queued prompt', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'idle' } })),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async () => {},
      isPromptQueued: (sessionId) => sessionId === 'coding-session',
    })

    watchdog.start(PLAN_LANE)
    await wait(80)

    expect(recoverCalls.length).toBe(0)
    expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(0)

    watchdog.stop(PLAN_LANE)
  })

  it('does not reset activity or the stall count while a prompt is queued', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []
    let queued = false

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getStallTimeoutMs: () => 10,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'idle' } })),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async () => {},
      isPromptQueued: () => queued,
    })

    vi.useFakeTimers()
    try {
      watchdog.start(PLAN_LANE)
      await vi.advanceTimersByTimeAsync(12)
      expect(recoverCalls.length).toBe(1)
      expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(1)

      queued = true
      await vi.advanceTimersByTimeAsync(50)
      expect(recoverCalls.length).toBe(1)
      expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(1)

      queued = false
      await vi.advanceTimersByTimeAsync(12)
      expect(recoverCalls.length).toBe(2)
      expect(watchdog.getStallInfo(PLAN_LANE)?.consecutiveStalls).toBe(2)
    } finally {
      watchdog.stop(PLAN_LANE)
      vi.useRealTimers()
    }
  })

  it('counts a non-busy stall again once no prompt is queued', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []
    let queued = true

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'idle' } })),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async () => {},
      isPromptQueued: () => queued,
    })

    watchdog.start(PLAN_LANE)
    await wait(80)
    expect(recoverCalls.length).toBe(0)

    queued = false
    await wait(80)
    expect(recoverCalls.length).toBeGreaterThanOrEqual(1)

    watchdog.stop(PLAN_LANE)
  })

  it('stops the previous lane timer when the active section run advances', async () => {
    const oldLane: LoopLane = { loopName: 'test-loop', sectionRunKey: 'section:one' }
    const newLane: LoopLane = { loopName: 'test-loop', sectionRunKey: 'section:two' }
    const stateRef = { current: makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, sectionRunKey: 'section:one' }) }
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getRunState: (_loopName, runKey) =>
            stateRef.current?.sectionRunKey === runKey ? stateRef.current : null,
        }),
      },
      client: createMockClient(async () => ({ 'coding-session': { type: 'idle' } })),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (_ln, _s, reason) => {
        terminateCalls.push(reason)
      },
    })

    vi.useFakeTimers()
    try {
      watchdog.start(oldLane)
      stateRef.current = makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, sectionRunKey: 'section:two' })
      // The old lane must notice the advance and stop itself before recovering.
      await vi.advanceTimersByTimeAsync(60)
      expect(recoverCalls.length).toBe(0)
      expect(terminateCalls.length).toBe(0)
      expect(watchdog.getStallInfo(oldLane)).toBeNull()

      // The new lane's timer runs and treats the idle session as a stall.
      watchdog.start(newLane)
      await vi.advanceTimersByTimeAsync(60)
      expect(recoverCalls.length).toBeGreaterThanOrEqual(1)
      expect(watchdog.getStallInfo(newLane)?.consecutiveStalls).toBeGreaterThan(0)
    } finally {
      watchdog.stop(newLane)
      vi.useRealTimers()
    }
  })

  it('reads the state of its own section run instead of the loop primary run', async () => {
    const laneA: LoopLane = { loopName: 'test-loop', sectionRunKey: 'section:a' }
    const laneB: LoopLane = { loopName: 'test-loop', sectionRunKey: 'section:b' }
    const stateA = makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, sectionRunKey: laneA.sectionRunKey, sessionId: 'session-a' })
    const stateB = makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, sectionRunKey: laneB.sectionRunKey, sessionId: 'session-b', phase: 'auditing' })
    const aFinished = { current: false }
    let statusCalls = 0
    const recoverCalls: unknown[] = []
    const terminateCalls: unknown[] = []

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          // The primary run is a different section run, in a different phase and session.
          getActiveState: () => stateB,
          getRunState: (_loopName, runKey) => {
            if (runKey === laneB.sectionRunKey) return stateB
            return aFinished.current ? null : stateA
          },
          resolveLoopName: (sessionId) =>
            sessionId === 'session-a' || sessionId === 'session-b' ? 'test-loop' : null,
        }),
      },
      client: createMockClient(async () => {
        statusCalls += 1
        return {
          'session-a': { type: 'busy', message: 'working' },
          'session-b': { type: 'idle' },
        }
      }),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async (_ln, _s, reason) => {
        terminateCalls.push(reason)
      },
    })

    vi.useFakeTimers()
    try {
      watchdog.start(laneA)
      await vi.advanceTimersByTimeAsync(12)

      // A is busy on its own run, so the idle primary run B must not stall it.
      expect(statusCalls).toBeGreaterThanOrEqual(1)
      expect(recoverCalls).toHaveLength(0)
      expect(terminateCalls).toHaveLength(0)
      expect(watchdog.getStallInfo(laneA)).not.toBeNull()

      // A's run finishes: the watchdog stops instead of reading B's state.
      aFinished.current = true
      await vi.advanceTimersByTimeAsync(60)
      expect(watchdog.getStallInfo(laneA)).toBeNull()

      const statusCallsAfterStop = statusCalls
      await vi.advanceTimersByTimeAsync(60)
      expect(statusCalls).toBe(statusCallsAfterStop)
      expect(recoverCalls).toHaveLength(0)
      expect(terminateCalls).toHaveLength(0)
    } finally {
      watchdog.stop(laneA)
      vi.useRealTimers()
    }
  })

  it('drops a stall tick whose status query resolves after the section run advanced', async () => {
    const oldLane: LoopLane = { loopName: 'test-loop', sectionRunKey: 'section:one' }
    const stateRef = { current: makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, sectionRunKey: 'section:one' }) }
    const recoverCalls: unknown[] = []
    let releaseStatus!: (value: any) => void
    const statusGate = new Promise((resolve) => {
      releaseStatus = resolve
    })

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({
          getActiveState: () => stateRef.current,
          getRunState: (_loopName, runKey) =>
            stateRef.current?.sectionRunKey === runKey ? stateRef.current : null,
        }),
      },
      client: createMockClient(() => statusGate),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async () => {},
    })

    vi.useFakeTimers()
    try {
      watchdog.start(oldLane)
      await vi.advanceTimersByTimeAsync(12)

      // The status query is in flight; the loop advances to another section run.
      stateRef.current = makeLoopState({ ...WATCHDOG_STATE_DEFAULTS, sectionRunKey: 'section:two' })
      releaseStatus({ 'coding-session': { type: 'idle' } })
      await vi.advanceTimersByTimeAsync(0)

      expect(recoverCalls).toHaveLength(0)
    } finally {
      watchdog.stop(oldLane)
      vi.useRealTimers()
    }
  })

  it('drops a stall tick from a superseded interval after the lane watchdog restarts', async () => {
    const stateRef = { current: makeLoopState(WATCHDOG_STATE_DEFAULTS) }
    const recoverCalls: unknown[] = []
    let statusCalls = 0
    let releaseFirst!: (value: any) => void
    const firstStatusGate = new Promise((resolve) => {
      releaseFirst = resolve
    })

    const { logger } = createCapturingLogger()
    const watchdog = createLoopWatchdog({
      projectId: 'test-project',
      loopService: {
        ...createMockLoopService({ getActiveState: () => stateRef.current }),
      },
      client: createMockClient(() => {
        statusCalls += 1
        return statusCalls === 1 ? firstStatusGate : Promise.resolve({})
      }),
      logger,
      nudge: vi.fn(),
      recover: async (_ln, _s, ctx) => {
        recoverCalls.push(ctx)
      },
      terminate: async () => {},
    })

    vi.useFakeTimers()
    try {
      watchdog.start(PLAN_LANE)
      await vi.advanceTimersByTimeAsync(12)

      // Restart replaces the interval while the first tick is still awaiting status.
      watchdog.stop(PLAN_LANE)
      watchdog.start(PLAN_LANE)
      releaseFirst({ 'coding-session': { type: 'idle' } })
      await vi.advanceTimersByTimeAsync(0)

      // The superseded tick must not recover on the restarted lane.
      expect(recoverCalls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(14)
      expect(recoverCalls.length).toBeGreaterThanOrEqual(1)
    } finally {
      watchdog.stop(PLAN_LANE)
      vi.useRealTimers()
    }
  })
})
