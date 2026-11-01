import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService, type LoopChangeNotifier } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoop, type Loop, type OnTerminatedCallback } from '../../src/loop/runtime'
import { __resetIdleGate } from '../../src/loop/idle-gate'
import type { Logger, PluginConfig } from '../../src/types'
import type { ForgeClient } from '../../src/client/port'
import { createTestDb } from '../helpers/test-db'

const PROJECT_ID = 'test-project'

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    defaultMaxIterations: 5,
  },
}

function createMockForgeClient(): ForgeClient {
  return {
    session: {
      create: async () => ({ id: 'sess' }) as any,
      promptAsync: async () => {},
      status: async () => ({}) as any,
      abort: async () => {},
      delete: async () => {},
      messages: async () => [],
      get: async () => ({}) as any,
      update: async () => {},
      compact: async () => {},
    },
    workspace: {
      create: async () => ({ id: '', directory: '/tmp/wt', branch: 'b' }) as any,
      list: async () => [],
      remove: async () => {},
      warp: async () => {},
    },
    model: {
      contextLimit: async () => undefined,
    },
    toast: async () => {},
  }
}

function createCapturingLogger(): { logger: Logger; logs: Array<{ level: string; message: string }> } {
  const logs: Array<{ level: string; message: string }> = []
  const logger: Logger = {
    log: (msg: string) => logs.push({ level: 'log', message: msg }),
    error: (msg: string) => logs.push({ level: 'error', message: msg }),
    debug: (msg: string) => logs.push({ level: 'debug', message: msg }),
  }
  return { logger, logs }
}

describe('Loop Runtime cancel()', () => {
  let db: ReturnType<typeof createTestDb>['db']
  let testDb: ReturnType<typeof createTestDb>
  let loopService: ReturnType<typeof createLoopService>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)

    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      { log: () => {}, error: () => {}, debug: () => {} },
      undefined,
      undefined,
      sectionPlansRepo,
    )

    __resetIdleGate()
  })

  afterEach(() => {
    testDb.cleanup()
    __resetIdleGate()
  })

  function makeActiveState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: 'session-abc',
      loopName: 'cancel-test-loop',
      worktreeDir: '/tmp/cancel-worktree',
      projectDir: '/tmp/host-project-dir',
      worktreeBranch: 'feature/cancel-test',
      iteration: 2,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      prompt: 'Test cancellation prompt',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      status: 'running',
      worktree: false,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      currentSectionIndex: 0,
      totalSections: 0,
      ...overrides,
    }
  }

  function createRuntime(overrides: {
    loopConfig?: Partial<PluginConfig>
    notify?: LoopChangeNotifier
    onTerminated?: OnTerminatedCallback
  } = {}): { loop: Loop; logger: Logger; logs: Array<{ level: string; message: string }> } {
    const { logger, logs } = createCapturingLogger()
    const config: PluginConfig = { ...mockConfig, ...(overrides.loopConfig ?? {}) }

    const loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      projectId: PROJECT_ID,
      client: createMockForgeClient(),
      logger,
      getConfig: () => config,
      notify: overrides.notify,
      onTerminated: overrides.onTerminated,
    })

    return { loop, logger, logs }
  }

  describe('cancel terminates with cancelled reason', () => {
    test('cancel marks the loop as inactive with user_aborted termination', async () => {
      const { loop } = createRuntime()
      const state = makeActiveState()
      loop.start({ state })

      await loop.cancel(state.loopName)

      const terminatedState = loopService.getAnyState(state.loopName)
      expect(terminatedState).not.toBeNull()
      expect(terminatedState!.active).toBe(false)
      expect(terminatedState!.terminationReason).toBe('user_aborted')
    })

  })

  describe('cancel fires termination callbacks', () => {
    test('termination callback receives the correct state and reason', async () => {
      let callbackInvoked = false
      let receivedState: LoopState | null = null

      const { logger } = createCapturingLogger()

      const loop = createLoop({
        loopsRepo,
        plansRepo,
        reviewFindingsRepo,
        sectionPlansRepo,
        projectId: PROJECT_ID,
        client: createMockForgeClient(),
        logger,
        getConfig: () => mockConfig,
        onTerminated: async (state, _reason) => {
          callbackInvoked = true
          receivedState = state
        },
      })

      const state = makeActiveState()
      loop.start({ state })
      await loop.cancel(state.loopName)

      expect(callbackInvoked).toBe(true)
      expect(receivedState).not.toBeNull()
      expect(receivedState!.loopName).toBe(state.loopName)
    })
  })

  describe('settled notify after termination side effects', () => {
    test('emits terminate before onTerminated and settled after it resolves', async () => {
      const events: string[] = []
      const settledHints: Array<{ projectDir?: string; worktreeDir?: string } | undefined> = []
      const notify: LoopChangeNotifier = (reason, _loopName, hint) => {
        events.push(`notify:${reason}`)
        if (reason === 'settled') settledHints.push(hint)
      }
      const { loop } = createRuntime({
        notify,
        onTerminated: async () => {
          events.push('onTerminated:start')
          await Promise.resolve()
          events.push('onTerminated:end')
        },
      })

      const state = makeActiveState()
      loop.start({ state })
      events.length = 0

      await loop.cancel(state.loopName)

      expect(events).toEqual([
        'notify:terminate',
        'onTerminated:start',
        'onTerminated:end',
        'notify:settled',
      ])
      expect(settledHints).toEqual([{ projectDir: state.projectDir, worktreeDir: state.worktreeDir }])
    })

    test('emits settled and propagates the error when onTerminated rejects', async () => {
      const settled: string[] = []
      const notify: LoopChangeNotifier = (reason) => {
        if (reason === 'settled') settled.push(reason)
      }
      const { loop } = createRuntime({
        notify,
        onTerminated: async () => {
          throw new Error('teardown failed')
        },
      })

      const state = makeActiveState()
      loop.start({ state })

      await expect(loop.cancel(state.loopName)).rejects.toThrow('teardown failed')
      expect(settled).toEqual(['settled'])
    })

    test('emits exactly one settled for duplicate concurrent termination', async () => {
      let settledCount = 0
      const notify: LoopChangeNotifier = (reason) => {
        if (reason === 'settled') settledCount += 1
      }
      const { loop } = createRuntime({
        notify,
        onTerminated: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
        },
      })

      const state = makeActiveState()
      loop.start({ state })

      await Promise.all([
        loop.terminate(state.loopName, { kind: 'user_aborted' }),
        loop.terminate(state.loopName, { kind: 'user_aborted' }),
      ])

      expect(settledCount).toBe(1)
    })

    test('does not emit settled for a loop that is not active', async () => {
      const settled: string[] = []
      const notify: LoopChangeNotifier = (reason) => {
        if (reason === 'settled') settled.push(reason)
      }
      const { loop } = createRuntime({ notify })

      const result = await loop.terminate('ghost-loop', { kind: 'user_aborted' })

      expect(result).toBe(false)
      expect(settled).toEqual([])
    })
  })

  describe('cancel clears timers', () => {
    test('after cancel, the loop is no longer active', async () => {
      const { loop } = createRuntime()
      const state = makeActiveState()
      loop.start({ state })

      await loop.cancel(state.loopName)

      const afterCancel = loop.listActive()
      expect(afterCancel.find(s => s.loopName === state.loopName)).toBeUndefined()
    })

    test('calling cancel on already cancelled loop does not throw', async () => {
      const { loop } = createRuntime()
      const state = makeActiveState()
      loop.start({ state })

      await loop.cancel(state.loopName)
      await expect(loop.cancel(state.loopName)).resolves.toBeUndefined()
    })
  })

  describe('cancelBySessionId works for sessions registered via start', () => {
    test('cancels by session ID when loop is started via start()', async () => {
      const { loop } = createRuntime()
      const state = makeActiveState()
      loop.start({ state })

      const result = await loop.cancelBySessionId(state.sessionId)

      expect(result).toBe(true)
      const terminated = loopService.getAnyState(state.loopName)!
      expect(terminated.active).toBe(false)
    })

    test('returns false for unknown session ID', async () => {
      const { loop } = createRuntime()
      const result = await loop.cancelBySessionId('unknown-session-id')
      expect(result).toBe(false)
    })
  })
})
