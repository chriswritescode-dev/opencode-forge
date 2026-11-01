import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { V2Event } from '@opencode/client'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoop, type Loop } from '../../src/loop/runtime'
import { __resetIdleGate } from '../../src/loop/idle-gate'
import { loopRegistry } from '../../src/utils/loop-registry'
import { normalizeV2Event } from '../../src/host/v2-events'
import type { Logger, PluginConfig } from '../../src/types'
import type { ForgeClient } from '../../src/client/port'
import { setupLoopsTestDb } from '../helpers/test-db'

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

describe('Loop Runtime start()', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-start-test-'))
    db = new Database(join(tempDir, 'test.db'))

    setupLoopsTestDb(db)

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
    loopRegistry.clear()
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
    __resetIdleGate()
    loopRegistry.clear()
  })

  function makeState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: 'session-123',
      loopName: 'test-loop',
      worktreeDir: '/tmp/test-worktree',
      projectDir: '/tmp/host-project-dir',
      worktreeBranch: 'test/branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      status: 'running',
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      currentSectionIndex: 0,
      totalSections: 0,
      ...overrides,
    }
  }

  function createRuntime(): { loop: Loop; logger: Logger; logs: Array<{ level: string; message: string }> } {
    const { logger, logs } = createCapturingLogger()
    const loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      projectId: PROJECT_ID,
      client: createMockForgeClient(),
      logger,
      getConfig: () => mockConfig,
    })
    return { loop, logger, logs }
  }

  describe('start writes initial state correctly', () => {
    test('persists active loop state via setState and registerLoopSession', () => {
      const { loop } = createRuntime()
      const state = makeState()

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
      const { loop } = createRuntime()
      const state = makeState({
        phase: 'coding',
      })

      loop.start({ state })

      const persisted = loopService.getActiveState(state.loopName)!
      expect(persisted.phase).toBe('coding')
    })

  })

  describe('start generates unique loop names', () => {
    test('allows multiple distinct loop names', () => {
      const { loop } = createRuntime()

      const state1 = makeState({ loopName: 'loop-alpha' })
      const state2 = makeState({ loopName: 'loop-beta', sessionId: 'session-beta' })

      loop.start({ state: state1 })
      loop.start({ state: state2 })

      const alpha = loopService.getAnyState('loop-alpha')
      const beta = loopService.getAnyState('loop-beta')

      expect(alpha).not.toBeNull()
      expect(beta).not.toBeNull()
      expect(alpha!.loopName).not.toBe(beta!.loopName)
    })

    test('does not overwrite existing loop when starting with a duplicate name', () => {
      const { loop, logs } = createRuntime()

      const existingState = makeState({ loopName: 'my-loop' })
      loop.start({ state: existingState })

      const existing = loopService.getAnyState('my-loop')
      expect(existing).not.toBeNull()
      expect(existing!.active).toBe(true)

      const duplicateState = makeState({
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
      const { loop, logs } = createRuntime()
      const state = makeState()

      loop.start({ state })

      expect(logs.some(l => l.message.includes('started loop='))).toBe(true)
      expect(logs.some(l => l.message.includes(state.loopName))).toBe(true)
    })
  })

  describe('generateUniqueLoopName returns unique names', () => {
    test('returns base name when no conflicts exist', () => {
      const { loop } = createRuntime()
      const result = loop.generateUniqueLoopName('fresh-name')
      expect(result).toBe('fresh-name')
    })

    test('returns suffixed name when base name already exists', () => {
      const { loop } = createRuntime()
      const state1 = makeState({ loopName: 'taken' })
      loop.start({ state: state1 })

      const result = loop.generateUniqueLoopName('taken')
      expect(result).toBe('taken-1')
    })

    test('increments counter through multiple conflicts', () => {
      const { loop } = createRuntime()

      const s1 = makeState({ loopName: 'loop' })
      const s2 = makeState({ loopName: 'loop-1', sessionId: 'session-loop-1' })
      const s3 = makeState({ loopName: 'loop-2', sessionId: 'session-loop-2' })
      loop.start({ state: s1 })
      loop.start({ state: s2 })
      loop.start({ state: s3 })

      const result = loop.generateUniqueLoopName('loop')
      expect(result).toBe('loop-3')
    })
  })

  describe('start enables listing by loop name', () => {
    test('started loop appears in listActive after start', () => {
      const { loop } = createRuntime()
      const state = makeState()

      loop.start({ state })

      const active = loop.listActive()
      expect(active.length).toBeGreaterThanOrEqual(1)
      expect(active.find(s => s.loopName === state.loopName)).toBeDefined()
    })
  })

  describe('only the instance owning the worktree supervises a loop', () => {
    function createRuntimeIn(directory?: string) {
      const { logger, logs } = createCapturingLogger()
      const loop = createLoop({
        loopsRepo,
        plansRepo,
        reviewFindingsRepo,
        sectionPlansRepo,
        projectId: PROJECT_ID,
        client: createMockForgeClient(),
        logger,
        getConfig: () => mockConfig,
        directory,
      })
      return { loop, logs }
    }

    function abortEvent(sessionId: string) {
      return {
        type: 'session.error',
        properties: { sessionID: sessionId, error: { name: 'MessageAbortedError' } },
      }
    }

    test('an instance bound to another directory does not start the watchdog', () => {
      const { loop, logs } = createRuntimeIn('/tmp/some-other-project')
      const state = makeState({ worktreeDir: '/tmp/owned-worktree' })
      loop.start({ state })

      loop.startWatchdog(state.loopName)

      expect(logs.some(l => l.message.includes('skipping watchdog for test-loop'))).toBe(true)
      expect(logs.some(l => l.message.includes('Loop watchdog: started'))).toBe(false)

      loop.clearAllRetryTimeouts()
    })

    test('the instance bound to the worktree does start the watchdog', () => {
      const { loop, logs } = createRuntimeIn('/tmp/owned-worktree')
      const state = makeState({ worktreeDir: '/tmp/owned-worktree' })
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
      const host = createRuntimeIn('/tmp/some-other-project')
      const state = makeState({ worktreeDir: '/tmp/owned-worktree' })
      host.loop.start({ state })

      const owner = createRuntimeIn('/tmp/owned-worktree')

      expect(host.loop.superviseOwnedLoops()).toEqual([])
      expect(createRuntimeIn().loop.superviseOwnedLoops()).toEqual([])
      expect(owner.loop.superviseOwnedLoops()).toEqual([state.loopName])
      expect(owner.logs.some(l => l.message.includes('Loop watchdog: started for loop test-loop'))).toBe(true)

      void owner.loop.terminateAll()
    })

    // Accepted ADR "No boot-time loop recovery": a loop persisted before this
    // process must not be supervised at init, even by the instance that owns its
    // worktree. Only loops started/restarted in this process are registered.
    test('a persisted owned loop not started in this process is not supervised', () => {
      const state = makeState({ worktreeDir: '/tmp/owned-worktree' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      const owner = createRuntimeIn('/tmp/owned-worktree')

      expect(owner.loop.superviseOwnedLoops()).toEqual([])
      expect(owner.logs.some(l => l.message.includes('Loop watchdog: started'))).toBe(false)

      void owner.loop.terminateAll()
    })

    // Regression: a non-owning instance never nudges, so it never holds the
    // internal-abort marker. Before the ownership gate it read the resulting
    // abort as a user abort and terminated a loop that was actively working.
    test('an aborted event on a non-owning instance does not terminate the loop', async () => {
      const { loop, logs } = createRuntimeIn('/tmp/some-other-project')
      const state = makeState({ worktreeDir: '/tmp/owned-worktree' })
      loop.start({ state })

      await loop.tick(abortEvent(state.sessionId))

      expect(loop.inspect(state.loopName)?.active).toBe(true)
      expect(logs.some(l => l.message.includes('is owned by another instance'))).toBe(true)
    })

    test('an aborted event on the owning instance still terminates the loop', async () => {
      const { loop } = createRuntimeIn('/tmp/owned-worktree')
      const state = makeState({ worktreeDir: '/tmp/owned-worktree' })
      loop.start({ state })

      await loop.tick(abortEvent(state.sessionId))

      expect(loop.inspect(state.loopName)?.active).toBe(false)
    })

    test('an instance with no directory stays ungated', async () => {
      const { loop } = createRuntimeIn(undefined)
      const state = makeState({ worktreeDir: '/tmp/owned-worktree' })
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
      const { loop } = createRuntimeIn('/tmp/owned-worktree')
      const state = makeState({ worktreeDir: '/tmp/owned-worktree' })
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
