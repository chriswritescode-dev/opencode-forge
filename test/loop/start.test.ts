import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { V2Event } from '@opencode/client'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { __resetIdleGate } from '../../src/loop/idle-gate'
import { loopRegistry } from '../../src/utils/loop-registry'
import { normalizeV2Event } from '../../src/host/v2-events'
import type { PluginConfig } from '../../src/types'
import { createTestDb } from '../helpers/test-db'
import { buildLoopRuntime, makeLoopState } from '../helpers/loop-fixtures'
import { createMockLogger } from '../helpers/logger'

const PROJECT_ID = 'test-project'
const START_STATE_DEFAULTS = {
  sessionId: 'session-123',
  worktreeDir: '/tmp/test-worktree',
} satisfies Partial<LoopState>

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    defaultMaxIterations: 5,
  },
}

describe('Loop Runtime start()', () => {
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
    loopRegistry.clear()
  })

  afterEach(() => {
    testDb.cleanup()
    __resetIdleGate()
    loopRegistry.clear()
  })

  describe('start writes initial state correctly', () => {
    test('persists active loop state via setState and registerLoopSession', () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const state = makeLoopState(START_STATE_DEFAULTS)

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)
      expect(persisted).not.toBeNull()
      expect(persisted!.active).toBe(true)
      expect(persisted!.sessionId).toBe(state.sessionId)
      expect(persisted!.loopName).toBe(state.loopName)
      expect(persisted!.worktreeDir).toBe(state.worktreeDir)
      expect(persisted!.phase).toBe('coding')
      expect(persisted!.iteration).toBe(1)
      expect(persisted!.maxIterations).toBe(5)
    })

    test('loop start always begins in phase=coding regardless of plan content', () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const state = makeLoopState({ ...START_STATE_DEFAULTS, phase: 'coding' })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('coding')
    })

  })

  describe('start generates unique loop names', () => {
    test('allows multiple distinct loop names', () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })

      const state1 = makeLoopState({ ...START_STATE_DEFAULTS, loopName: 'loop-alpha' })
      const state2 = makeLoopState({ ...START_STATE_DEFAULTS, loopName: 'loop-beta', sessionId: 'session-beta' })

      loop.start({ state: state1 })
      loop.start({ state: state2 })

      const alpha = loopService.getAnyState('loop-alpha')
      const beta = loopService.getAnyState('loop-beta')

      expect(alpha).not.toBeNull()
      expect(beta).not.toBeNull()
      expect(alpha!.loopName).not.toBe(beta!.loopName)
    })

    test('does not overwrite existing loop when starting with a duplicate name', () => {
      const { loop, logs } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })

      const existingState = makeLoopState({ ...START_STATE_DEFAULTS, loopName: 'my-loop' })
      loop.start({ state: existingState })

      const existing = loopService.getAnyState('my-loop')
      expect(existing).not.toBeNull()
      expect(existing!.active).toBe(true)

      const duplicateState = makeLoopState({
        ...START_STATE_DEFAULTS,
        loopName: 'my-loop',
        sessionId: 'session-duplicate',
        iteration: 5,
      })
      loop.start({ state: duplicateState })

      const originalAfterDuplicate = loopService.getAnyState('my-loop')
      expect(originalAfterDuplicate).not.toBeNull()
      expect(originalAfterDuplicate!.sessionId).toBe(existingState.sessionId)
      expect(originalAfterDuplicate!.iteration).toBe(1)

      const renamed = loopService.getAnyState('my-loop-1')
      expect(renamed).not.toBeNull()
      expect(renamed!.sessionId).toBe(duplicateState.sessionId)

      expect(logs.some(l => l.message.includes('auto-renamed to my-loop-1'))).toBe(true)
    })
  })

  describe('start records activity log', () => {
    test('logs the start operation', () => {
      const { loop, logs } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const state = makeLoopState(START_STATE_DEFAULTS)

      loop.start({ state })

      expect(logs.some(l => l.message.includes('started loop='))).toBe(true)
      expect(logs.some(l => l.message.includes(state.loopName))).toBe(true)
    })
  })

  describe('generateUniqueLoopName returns unique names', () => {
    test('returns base name when no conflicts exist', () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const result = loop.generateUniqueLoopName('fresh-name')
      expect(result).toBe('fresh-name')
    })

    test('returns suffixed name when base name already exists', () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const state1 = makeLoopState({ ...START_STATE_DEFAULTS, loopName: 'taken' })
      loop.start({ state: state1 })

      const result = loop.generateUniqueLoopName('taken')
      expect(result).toBe('taken-1')
    })

    test('increments counter through multiple conflicts', () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })

      const s1 = makeLoopState({ ...START_STATE_DEFAULTS, loopName: 'loop' })
      const s2 = makeLoopState({ ...START_STATE_DEFAULTS, loopName: 'loop-1', sessionId: 'session-loop-1' })
      const s3 = makeLoopState({ ...START_STATE_DEFAULTS, loopName: 'loop-2', sessionId: 'session-loop-2' })
      loop.start({ state: s1 })
      loop.start({ state: s2 })
      loop.start({ state: s3 })

      const result = loop.generateUniqueLoopName('loop')
      expect(result).toBe('loop-3')
    })
  })

  describe('start enables listing by loop name', () => {
    test('started loop appears in listActive after start', () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const state = makeLoopState(START_STATE_DEFAULTS)

      loop.start({ state })

      const active = loop.listActive()
      expect(active.length).toBeGreaterThanOrEqual(1)
      expect(active.find(s => s.loopName === state.loopName)).toBeDefined()
    })
  })

  describe('only the instance owning the worktree supervises a loop', () => {
    function abortEvent(sessionId: string) {
      return {
        type: 'session.error',
        properties: { sessionID: sessionId, error: { name: 'MessageAbortedError' } },
      }
    }

    test('an instance bound to another directory does not start the watchdog', () => {
      const { loop, logs } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, directory: '/tmp/some-other-project' })
      const state = makeLoopState({ ...START_STATE_DEFAULTS, worktreeDir: '/tmp/owned-worktree' })
      loop.start({ state })

      loop.startWatchdog(state.loopName)

      expect(logs.some(l => l.message.includes('skipping watchdog for test-loop'))).toBe(true)
      expect(logs.some(l => l.message.includes('Loop watchdog: started'))).toBe(false)

      loop.clearAllRetryTimeouts()
    })

    test('the instance bound to the worktree does start the watchdog', () => {
      const { loop, logs } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, directory: '/tmp/owned-worktree' })
      const state = makeLoopState({ ...START_STATE_DEFAULTS, worktreeDir: '/tmp/owned-worktree' })
      loop.start({ state })

      loop.startWatchdog(state.loopName)

      expect(logs.some(l => l.message.includes('Loop watchdog: started for loop test-loop'))).toBe(true)
      expect(logs.some(l => l.message.includes('skipping watchdog'))).toBe(false)

      void loop.terminateAll()
    })

    // Regression: a worktree instance that boots after its loop started (remote
    // servers boot the worktree location lazily) missed the first idle event and
    // never started supervision, so the loop sat idle forever.
    test('an owning instance created after the loop started supervises it', () => {
      const host = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, directory: '/tmp/some-other-project' })
      const state = makeLoopState({ ...START_STATE_DEFAULTS, worktreeDir: '/tmp/owned-worktree' })
      host.loop.start({ state })

      const owner = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, directory: '/tmp/owned-worktree' })

      expect(host.loop.superviseOwnedLoops()).toEqual([])
      expect(buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig }).loop.superviseOwnedLoops()).toEqual([])
      expect(owner.loop.superviseOwnedLoops()).toEqual([state.loopName])
      expect(owner.logs.some(l => l.message.includes('Loop watchdog: started for loop test-loop'))).toBe(true)

      void owner.loop.terminateAll()
    })

    // Accepted ADR "No boot-time loop recovery": a loop persisted before this
    // process must not be supervised at init, even by the instance that owns its
    // worktree. Only loops started/restarted in this process are registered.
    test('a persisted owned loop not started in this process is not supervised', () => {
      const state = makeLoopState({ ...START_STATE_DEFAULTS, worktreeDir: '/tmp/owned-worktree' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      const owner = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, directory: '/tmp/owned-worktree' })

      expect(owner.loop.superviseOwnedLoops()).toEqual([])
      expect(owner.logs.some(l => l.message.includes('Loop watchdog: started'))).toBe(false)

      void owner.loop.terminateAll()
    })

    // Regression: a non-owning instance never nudges, so it never holds the
    // internal-abort marker. Before the ownership gate it read the resulting
    // abort as a user abort and terminated a loop that was actively working.
    test('an aborted event on a non-owning instance does not terminate the loop', async () => {
      const { loop, logs } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, directory: '/tmp/some-other-project' })
      const state = makeLoopState({ ...START_STATE_DEFAULTS, worktreeDir: '/tmp/owned-worktree' })
      loop.start({ state })

      await loop.tick(abortEvent(state.sessionId))

      expect(loop.inspect(state.loopName)?.active).toBe(true)
      expect(logs.some(l => l.message.includes('is owned by another instance'))).toBe(true)
    })

    test('an aborted event on the owning instance still terminates the loop', async () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, directory: '/tmp/owned-worktree' })
      const state = makeLoopState({ ...START_STATE_DEFAULTS, worktreeDir: '/tmp/owned-worktree' })
      loop.start({ state })

      await loop.tick(abortEvent(state.sessionId))

      expect(loop.inspect(state.loopName)?.active).toBe(false)
    })

    test('an instance with no directory stays ungated', async () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig })
      const state = makeLoopState({ ...START_STATE_DEFAULTS, worktreeDir: '/tmp/owned-worktree' })
      loop.start({ state })

      await loop.tick(abortEvent(state.sessionId))

      expect(loop.inspect(state.loopName)?.active).toBe(false)
    })

    // Regression: V2 reports an explicit user stop as
    // session.execution.interrupted(reason=user), not as a MessageAbortedError,
    // and follows it with idle. The normalized stop must terminate the loop
    // through the existing abort branch; otherwise the trailing idle runs the
    // coding phase runner and the loop advances instead of honoring the stop.
    test('a normalized V2 user interruption terminates an owned coding loop as user_aborted', async () => {
      const { loop } = buildLoopRuntime(db, { projectId: PROJECT_ID, config: mockConfig, directory: '/tmp/owned-worktree' })
      const state = makeLoopState({ ...START_STATE_DEFAULTS, worktreeDir: '/tmp/owned-worktree' })
      loop.start({ state })

      const interrupted: V2Event = {
        id: 'evt-1',
        created: 1,
        type: 'session.execution.interrupted',
        durable: { aggregateID: state.sessionId, seq: 1, version: 1 },
        location: { directory: '/tmp/owned-worktree' },
        data: { sessionID: state.sessionId, reason: 'user' },
      }
      const idle: V2Event = {
        id: 'evt-2',
        created: 2,
        type: 'session.status',
        data: { sessionID: state.sessionId, status: { type: 'idle' } },
      }

      for (const event of normalizeV2Event(interrupted)) {
        await loop.tick(event)
      }
      for (const event of normalizeV2Event(idle)) {
        await loop.tick(event)
      }

      const terminated = loopService.getAnyState(state.loopName)
      expect(terminated?.active).toBe(false)
      expect(terminated?.terminationReason).toBe('user_aborted')
      expect(terminated?.phase).toBe('coding')
    })
  })
})
