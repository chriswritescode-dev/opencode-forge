import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService, type LoopChangeNotifier } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { __resetIdleGate } from '../../src/loop/idle-gate'
import type { PluginConfig } from '../../src/types'
import { createTestDb } from '../helpers/test-db'
import { buildLoopRuntime, makeLoopState } from '../helpers/loop-fixtures'
import { createMockLogger } from '../helpers/logger'

const PROJECT_ID = 'test-project'
const CANCEL_STATE_DEFAULTS = {
  sessionId: 'session-abc',
  loopName: 'cancel-test-loop',
  worktreeDir: '/tmp/cancel-worktree',
  worktreeBranch: 'feature/cancel-test',
  iteration: 2,
  maxIterations: 10,
  prompt: 'Test cancellation prompt',
  worktree: false,
} satisfies Partial<LoopState>

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    defaultMaxIterations: 5,
  },
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
      createMockLogger(),
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

  describe('cancel terminates with cancelled reason', () => {
    test('cancel marks the loop as inactive with user_aborted termination', async () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
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

      const { loop } = buildLoopRuntime(db, {
        projectId: PROJECT_ID,
        config: mockConfig,
        onTerminated: async (state, _reason) => {
          callbackInvoked = true
          receivedState = state
        },
      })

      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
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
      const { loop } = buildLoopRuntime(db, {
        projectId: PROJECT_ID,
        config: mockConfig,
        notify,
        onTerminated: async () => {
          events.push('onTerminated:start')
          await Promise.resolve()
          events.push('onTerminated:end')
        },
      })

      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
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
      const { loop } = buildLoopRuntime(db, {
        projectId: PROJECT_ID,
        config: mockConfig,
        notify,
        onTerminated: async () => {
          throw new Error('teardown failed')
        },
      })

      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
      loop.start({ state })

      await expect(loop.cancel(state.loopName)).rejects.toThrow('teardown failed')
      expect(settled).toEqual(['settled'])
    })

    test('emits exactly one settled for duplicate concurrent termination', async () => {
      let settledCount = 0
      const notify: LoopChangeNotifier = (reason) => {
        if (reason === 'settled') settledCount += 1
      }
      const { loop } = buildLoopRuntime(db, {
        projectId: PROJECT_ID,
        config: mockConfig,
        notify,
        onTerminated: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
        },
      })

      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
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
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, notify })

      const result = await loop.terminate('ghost-loop', { kind: 'user_aborted' })

      expect(result).toBe(false)
      expect(settled).toEqual([])
    })
  })

  describe('cancel clears timers', () => {
    test('after cancel, the loop is no longer active', async () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
      loop.start({ state })

      await loop.cancel(state.loopName)

      const afterCancel = loop.listActive()
      expect(afterCancel.find(s => s.loopName === state.loopName)).toBeUndefined()
    })

    test('calling cancel on already cancelled loop does not throw', async () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
      loop.start({ state })

      await loop.cancel(state.loopName)
      await expect(loop.cancel(state.loopName)).resolves.toBeUndefined()
    })
  })

  describe('cancelBySessionId works for sessions registered via start', () => {
    test('cancels by session ID when loop is started via start()', async () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
      loop.start({ state })

      const result = await loop.cancelBySessionId(state.sessionId)

      expect(result).toBe(true)
      const terminated = loopService.getAnyState(state.loopName)!
      expect(terminated.active).toBe(false)
    })

    test('returns false for unknown session ID', async () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const result = await loop.cancelBySessionId('unknown-session-id')
      expect(result).toBe(false)
    })
  })
})
