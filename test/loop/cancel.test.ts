import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LoopChangeNotifier } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { __resetIdleGate } from '../../src/loop/idle-gate'
import type { PluginConfig } from '../../src/types'
import { createTestDb } from '../helpers/test-db'
import { createFakeForgeClient } from '../helpers/fake-client'
import { buildLoopRuntime, makeLoopState } from '../helpers/loop-fixtures'

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
  let loopService: ReturnType<typeof buildLoopRuntime>['loopService']

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db

    __resetIdleGate()
  })

  afterEach(() => {
    testDb.cleanup()
    __resetIdleGate()
  })

  const buildRuntime = (options: Parameters<typeof buildLoopRuntime>[1] = {}) => {
    const runtime = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, ...options })
    loopService = runtime.loopService
    return runtime
  }

  describe('cancel terminates with cancelled reason', () => {
    test('cancel marks the loop as inactive with user_aborted termination', async () => {
      const { loop } = buildRuntime()
      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
      loop.start({ state })

      await loop.cancel(state.loopName)

      const terminatedState = loopService.getAnyState(state.loopName)
      expect(terminatedState).not.toBeNull()
      expect(terminatedState!.active).toBe(false)
      expect(terminatedState!.terminationReason).toBe('user_aborted')
    })

    test('cancel discards the pending handoff', async () => {
      const { loop, loopsRepo } = buildRuntime()
      const state = makeLoopState({ ...CANCEL_STATE_DEFAULTS, loopName: 'cancel-handoff-loop' })
      loop.start({ state })
      const pending = loopsRepo.upsertPendingHandoff({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sessionId: state.sessionId,
        role: 'coder',
        phase: 'coding',
        sectionIndex: 0,
        sectionRunKey: 'plan',
        iteration: state.iteration,
        payload: {
          changes: [{ summary: 'Pending change', reason: 'Pending reason' }],
          deviations: [],
          verification: [{ command: 'pnpm test', cwd: '.', outcome: 'pass', changedAfter: false }],
        },
      })

      await loop.cancel(state.loopName)

      expect(loopsRepo.getPendingHandoff(PROJECT_ID, state.loopName, 'plan')).toBeNull()
      const history = loopsRepo.listHandoffs(PROJECT_ID, state.loopName)
      expect(history).toHaveLength(1)
      expect(history[0].id).toBe(pending.record.id)
      expect(history[0].status).toBe('discarded')
    })

  })

  describe('cancel fires termination callbacks', () => {
    test('termination callback receives the correct state and reason', async () => {
      let callbackInvoked = false
      let receivedState: LoopState | null = null

      const { loop } = buildRuntime({
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
      const { loop } = buildRuntime({
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
      const { loop } = buildRuntime({
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
      const { loop } = buildRuntime({
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
      const { loop } = buildRuntime({ notify })

      const result = await loop.terminate('ghost-loop', { kind: 'user_aborted' })

      expect(result).toBe(false)
      expect(settled).toEqual([])
    })
  })

  describe('cancel clears timers', () => {
    test('after cancel, the loop is no longer active', async () => {
      const { loop } = buildRuntime()
      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
      loop.start({ state })

      await loop.cancel(state.loopName)

      const afterCancel = loop.listActive()
      expect(afterCancel.find(s => s.loopName === state.loopName)).toBeUndefined()
    })

    test('calling cancel on already cancelled loop does not throw', async () => {
      const { loop } = buildRuntime()
      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
      loop.start({ state })

      await loop.cancel(state.loopName)
      await expect(loop.cancel(state.loopName)).resolves.toBeUndefined()
    })
  })

  describe('cancelBySessionId works for sessions registered via start', () => {
    test('cancels by session ID when loop is started via start()', async () => {
      const { loop } = buildRuntime()
      const state = makeLoopState(CANCEL_STATE_DEFAULTS)
      loop.start({ state })

      const result = await loop.cancelBySessionId(state.sessionId)

      expect(result).toBe(true)
      const terminated = loopService.getAnyState(state.loopName)!
      expect(terminated.active).toBe(false)
    })

    test('returns false for unknown session ID', async () => {
      const { loop } = buildRuntime()
      const result = await loop.cancelBySessionId('unknown-session-id')
      expect(result).toBe(false)
    })
  })

  describe('cancel covers every active run', () => {
    test('aborts and deletes the sessions of all active section lanes', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })
      const loopName = 'cancel-multi-lane'
      const state = makeLoopState({
        ...CANCEL_STATE_DEFAULTS,
        loopName,
        totalSections: 2,
        maxParallelSections: 2,
      })
      loopService.setState(loopName, state)
      loopService.activateSectionRun(
        loopName,
        { kind: 'section', sectionId: 'a', sectionIndex: 0 },
        {
          sessionId: 'session-lane-a',
          phase: 'coding',
          standbySessionId: null,
          laneDir: '/tmp/lane-a',
          laneBranch: 'forge-lane/x/a',
          laneBaseCommit: 'abc',
        },
        { exclusive: true },
      )
      loopService.activateSectionRun(
        loopName,
        { kind: 'section', sectionId: 'b', sectionIndex: 1 },
        {
          sessionId: 'session-lane-b',
          phase: 'coding',
          standbySessionId: null,
          laneDir: '/tmp/lane-b',
          laneBranch: 'forge-lane/x/b',
          laneBaseCommit: 'abc',
        },
        { exclusive: false },
      )

      await loop.cancel(loopName)

      const abortedSessions = calls
        .filter(c => c.method === 'session.abort')
        .map(c => (c.params as { sessionID: string }).sessionID)
      expect(abortedSessions).toEqual(expect.arrayContaining(['session-lane-a', 'session-lane-b']))

      expect(loopService.getAnyState(loopName)!.active).toBe(false)

      await vi.waitFor(() => {
        const deletedSessions = calls
          .filter(c => c.method === 'session.delete')
          .map(c => (c.params as { sessionID: string }).sessionID)
        expect(deletedSessions).toEqual(expect.arrayContaining(['session-lane-a', 'session-lane-b']))
      })
    })
  })

  describe('cancel keeps the session of a non-lane run', () => {
    test('does not delete an attached loop host session on cancel', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })
      const loopName = 'cancel-attached-host'
      const state = makeLoopState({
        ...CANCEL_STATE_DEFAULTS,
        loopName,
        sessionId: 'session-attached-host',
        hostSessionId: 'session-attached-host',
      })
      loopService.setState(loopName, state)

      await loop.cancel(loopName)

      const abortedSessions = calls
        .filter(c => c.method === 'session.abort')
        .map(c => (c.params as { sessionID: string }).sessionID)
      expect(abortedSessions).toContain('session-attached-host')

      const deletedSessions = calls
        .filter(c => c.method === 'session.delete')
        .map(c => (c.params as { sessionID: string }).sessionID)
      expect(deletedSessions).not.toContain('session-attached-host')
      expect(loopService.getAnyState(loopName)!.active).toBe(false)
    })

    test('does not delete a serial loop session on cancel', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })
      const loopName = 'cancel-serial-session'
      const state = makeLoopState({
        ...CANCEL_STATE_DEFAULTS,
        loopName,
        sessionId: 'session-serial',
        hostSessionId: 'session-host',
      })
      loopService.setState(loopName, state)

      await loop.cancel(loopName)

      const abortedSessions = calls
        .filter(c => c.method === 'session.abort')
        .map(c => (c.params as { sessionID: string }).sessionID)
      expect(abortedSessions).toContain('session-serial')

      const deletedSessions = calls
        .filter(c => c.method === 'session.delete')
        .map(c => (c.params as { sessionID: string }).sessionID)
      expect(deletedSessions).not.toContain('session-serial')
      expect(loopService.getAnyState(loopName)!.active).toBe(false)
    })
  })
})
