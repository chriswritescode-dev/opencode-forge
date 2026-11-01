import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import { createLoopEventHandler } from '../../src/hooks/loop'
import { markPromptSent, isAwaitingBusy, AWAITING_BUSY_TIMEOUT_MS, __resetIdleGate } from '../../src/loop/idle-gate'
import type { PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createTestDb } from '../helpers/test-db'
import { createCapturingLogger, createMockLogger } from '../helpers/logger'
import { makeLoopState } from '../helpers/loop-fixtures'

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
  let db: ReturnType<typeof createTestDb>['db']
  let testDb: ReturnType<typeof createTestDb>
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let handler: ReturnType<typeof createLoopEventHandler> | null

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-event-gate-test-'))
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
    handler?.clearAllRetryTimeouts()
    testDb.cleanup()
    rmSync(tempDir, { recursive: true, force: true })
    __resetIdleGate()
    handler = null
  })

  const EVENT_GATE_STATE_DEFAULTS = {
    totalSections: 2,
  }

  function createHandler() {
    const { logger } = createCapturingLogger()
    const { client: forgeClient } = createFakeForgeClient()

    handler = createLoopEventHandler(
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
    return handler
  }

  describe('busy event clears pending gate', () => {
    test('busy event for awaiting session clears pending entry', async () => {
      const handler = createHandler()
      const state = makeLoopState({ ...EVENT_GATE_STATE_DEFAULTS, sessionId: 'S1' })
      loopService.setState(state.loopName, state)

      markPromptSent(PROJECT_ID, state.loopName, 'S1', createMockLogger())
      expect(isAwaitingBusy(PROJECT_ID, state.loopName, 'S1')).toBe(true)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'busy' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(PROJECT_ID, state.loopName, 'S1')).toBe(false)
    })

    test('busy event for non-awaiting session does not clear pending', async () => {
      const handler = createHandler()
      const state = makeLoopState({ ...EVENT_GATE_STATE_DEFAULTS, sessionId: 'S1' })
      loopService.setState(state.loopName, state)

      markPromptSent(PROJECT_ID, state.loopName, 'S1', createMockLogger())

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'busy' },
            sessionID: 'S999',
          },
        },
      })

      expect(isAwaitingBusy(PROJECT_ID, state.loopName, 'S1')).toBe(true)
    })
  })

  describe('idle event gating', () => {
    test('premature idle is suppressed when awaiting busy', async () => {
      const handler = createHandler()
      const state = makeLoopState({ ...EVENT_GATE_STATE_DEFAULTS, sessionId: 'S1' })
      loopService.setState(state.loopName, state)

      markPromptSent(PROJECT_ID, state.loopName, 'S1', createMockLogger())

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'idle' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(PROJECT_ID, state.loopName, 'S1')).toBe(true)
    })

    test('idle event is processed after busy clears the gate', async () => {
      const handler = createHandler()
      const state = makeLoopState({ ...EVENT_GATE_STATE_DEFAULTS, sessionId: 'S1', phase: 'coding' })
      loopService.setState(state.loopName, state)

      markPromptSent(PROJECT_ID, state.loopName, 'S1', createMockLogger())

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'busy' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(PROJECT_ID, state.loopName, 'S1')).toBe(false)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'idle' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(PROJECT_ID, state.loopName, 'S1')).toBe(false)
    })

    test('idle event is processed after timeout expiration', async () => {
      vi.useFakeTimers()
      try {
        const handler = createHandler()
        const state = makeLoopState({ ...EVENT_GATE_STATE_DEFAULTS, sessionId: 'S2', phase: 'coding' })
        loopService.setState(state.loopName, state)

        markPromptSent(PROJECT_ID, state.loopName, 'S2', createMockLogger())

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

        expect(isAwaitingBusy(PROJECT_ID, state.loopName, 'S2')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('event sequence simulation', () => {
    test('given rotate -> mark prompt sent -> idle (S1) -> busy (S1) -> idle (S1), first idle is suppressed, second is processed', async () => {
      const handler = createHandler()
      const state = makeLoopState({ ...EVENT_GATE_STATE_DEFAULTS, sessionId: 'S1', phase: 'coding' })
      loopService.setState(state.loopName, state)

      markPromptSent(PROJECT_ID, state.loopName, 'S1', createMockLogger())

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'idle' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(PROJECT_ID, state.loopName, 'S1')).toBe(true)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'busy' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(PROJECT_ID, state.loopName, 'S1')).toBe(false)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'idle' },
            sessionID: 'S1',
          },
        },
      })

      expect(isAwaitingBusy(PROJECT_ID, state.loopName, 'S1')).toBe(false)
    })
  })
})
