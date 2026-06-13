import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoopEventHandler } from '../../src/hooks/loop'
import { markPromptSent, clearPromptPending, sessionsAwaitingBusy, isAwaitingBusy, isAwaitingBusyExpired, AWAITING_BUSY_TIMEOUT_MS } from '../../src/loop/idle-gate'
import type { Logger, PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const PROJECT_ID = 'test-project'

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    defaultMaxIterations: 5,
  },
}

describe('Loop Event Idle Gate', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-event-gate-test-'))
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

    sessionsAwaitingBusy.clear()
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
    sessionsAwaitingBusy.clear()
  })

  function makeState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: 'loop-session-id',
      loopName: 'test-loop',
      worktreeDir: '/tmp/nonexistent-worktree-for-test',
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
      totalSections: 2,
      finalAuditDone: false,
      ...overrides,
    }
  }

  function createCapturingLogger() {
    const logs: Array<{ level: string; message: string }> = []
    const logger: Logger = {
      log: (msg: string) => logs.push({ level: 'log', message: msg }),
      error: (msg: string) => logs.push({ level: 'error', message: msg }),
      debug: (msg: string) => logs.push({ level: 'debug', message: msg }),
    }
    return { logger, logs }
  }

  function createHandler() {
    const { logger } = createCapturingLogger()
    const { client: forgeClient } = createFakeForgeClient()

    return createLoopEventHandler(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      forgeClient,
      logger,
      () => mockConfig,
      undefined,
      tempDir,
    )
  }

  describe('busy event clears pending gate', () => {
    test('busy event for awaiting session clears pending entry', async () => {
      const handler = createHandler()
      const state = makeState({ sessionId: 'S1' })
      loopService.setState(state.loopName, state)

      markPromptSent(state.loopName, 'S1', { log: vi.fn(), error: vi.fn(), debug: vi.fn() })
      expect(isAwaitingBusy(state.loopName, 'S1')).toBe(true)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'busy' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(state.loopName, 'S1')).toBe(false)
    })

    test('busy event for non-awaiting session does not clear pending', async () => {
      const handler = createHandler()
      const state = makeState({ sessionId: 'S1' })
      loopService.setState(state.loopName, state)

      markPromptSent(state.loopName, 'S1', { log: vi.fn(), error: vi.fn(), debug: vi.fn() })

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'busy' },
            sessionID: 'S999',
          },
        },
      })

      expect(isAwaitingBusy(state.loopName, 'S1')).toBe(true)
    })
  })

  describe('idle event gating', () => {
    test('premature idle is suppressed when awaiting busy', async () => {
      const handler = createHandler()
      const state = makeState({ sessionId: 'S1' })
      loopService.setState(state.loopName, state)

      markPromptSent(state.loopName, 'S1', { log: vi.fn(), error: vi.fn(), debug: vi.fn() })

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'idle' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(state.loopName, 'S1')).toBe(true)
    })

    test('idle event is processed after busy clears the gate', async () => {
      const handler = createHandler()
      const state = makeState({ sessionId: 'S1', phase: 'coding' })
      loopService.setState(state.loopName, state)

      markPromptSent(state.loopName, 'S1', { log: vi.fn(), error: vi.fn(), debug: vi.fn() })

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'busy' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(state.loopName, 'S1')).toBe(false)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'idle' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(state.loopName, 'S1')).toBe(false)
    })

    test('idle event is processed after timeout expiration', async () => {
      vi.useFakeTimers()
      try {
        const handler = createHandler()
        const state = makeState({ sessionId: 'S2', phase: 'coding' })
        loopService.setState(state.loopName, state)

        markPromptSent(state.loopName, 'S2', { log: vi.fn(), error: vi.fn(), debug: vi.fn() })

        vi.setSystemTime(Date.now() + AWAITING_BUSY_TIMEOUT_MS + 1)

        await handler.onEvent({
          event: {
            type: 'session.status',
            properties: {
              status: { type: 'idle' },
              sessionID: 'S2',
            },
          },
        })

        expect(isAwaitingBusy(state.loopName, 'S2')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('event sequence simulation', () => {
    test('given rotate -> mark prompt sent -> idle (S1) -> busy (S1) -> idle (S1), first idle is suppressed, second is processed', async () => {
      const handler = createHandler()
      const state = makeState({ sessionId: 'S1', phase: 'coding' })
      loopService.setState(state.loopName, state)

      markPromptSent(state.loopName, 'S1', { log: vi.fn(), error: vi.fn(), debug: vi.fn() })

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'idle' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(state.loopName, 'S1')).toBe(true)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'busy' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(state.loopName, 'S1')).toBe(false)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'idle' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(state.loopName, 'S1')).toBe(false)
    })
  })
})
