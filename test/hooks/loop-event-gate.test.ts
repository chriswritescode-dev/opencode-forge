import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService, type LoopState } from '../../src/services/loop'
import { createLoopEventHandler } from '../../src/hooks/loop'
import { markPromptSent, clearPromptPending, sessionsAwaitingBusy, isAwaitingBusy, isAwaitingBusyExpired, AWAITING_BUSY_TIMEOUT_MS } from '../../src/hooks/loop-idle-gate'
import type { Logger, PluginConfig } from '../../src/types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

const PROJECT_ID = 'test-project'

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    model: 'test/loop',
    defaultMaxIterations: 5,
  },
}

type DeleteCall = { sessionID: string; directory: string }
type PublishCall = { directory: string; body: unknown }

interface MockClientState {
  deleteCalls: DeleteCall[]
  publishCalls: PublishCall[]
  deleteThrows: boolean
}

function createMockV2Client(state: MockClientState): OpencodeClient {
  return {
    session: {
      create: async () => ({ error: null, data: { id: 'sess' } }),
      promptAsync: async () => ({ error: null, data: null }),
      status: async () => ({ error: null, data: {} }),
      abort: async () => {},
      delete: async (params: DeleteCall) => {
        state.deleteCalls.push(params)
        if (state.deleteThrows) throw new Error('delete failed')
        return { error: undefined }
      },
      messages: async () => ({ error: null, data: [] }),
      get: async () => ({ error: null, data: {} }),
    },
    tui: {
      publish: async (params: PublishCall) => {
        state.publishCalls.push(params)
      },
      selectSession: async () => {},
    },
    worktree: {
      create: async () => ({ error: null, data: { directory: '/tmp/wt', branch: 'b' } }),
      remove: async () => {},
    },
  } as unknown as OpencodeClient
}

describe('Loop Event Idle Gate', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-event-gate-test-'))
    db = new Database(join(tempDir, 'test.db'))

    db.exec(`
      CREATE TABLE loops (
        project_id           TEXT NOT NULL,
        loop_name            TEXT NOT NULL,
        status               TEXT NOT NULL,
        current_session_id   TEXT NOT NULL,
        worktree             INTEGER NOT NULL,
        worktree_dir         TEXT NOT NULL,
        session_directory    TEXT,
        worktree_branch      TEXT,
        project_dir          TEXT NOT NULL,
        max_iterations       INTEGER NOT NULL,
        iteration            INTEGER NOT NULL DEFAULT 0,
        audit_count          INTEGER NOT NULL DEFAULT 0,
        error_count          INTEGER NOT NULL DEFAULT 0,
        phase                TEXT NOT NULL,
        execution_model      TEXT,
        auditor_model        TEXT,
        model_failed         INTEGER NOT NULL DEFAULT 0,
        sandbox              INTEGER NOT NULL DEFAULT 0,
        sandbox_container    TEXT,
        started_at           INTEGER NOT NULL,
        completed_at         INTEGER,
        termination_reason   TEXT,
        completion_summary   TEXT,
        workspace_id         TEXT,
        host_session_id      TEXT,
        audit_session_id     TEXT,
        decomposition_status TEXT NOT NULL DEFAULT 'pending' CHECK (decomposition_status IN ('pending','running','completed','failed','skipped')),
        decomposition_mode TEXT NOT NULL DEFAULT 'agent' CHECK (decomposition_mode IN ('agent','deterministic')),
        decomposition_session_id TEXT,
        current_section_index INTEGER NOT NULL DEFAULT 0,
        total_sections INTEGER NOT NULL DEFAULT 0,
        final_audit_done INTEGER NOT NULL DEFAULT 0,
        final_audit_attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, loop_name)
      )
    `)

    db.exec(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
        prompt              TEXT,
        last_audit_result   TEXT,
        PRIMARY KEY (project_id, loop_name),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    db.exec(`
      CREATE TABLE plans (
        project_id   TEXT NOT NULL,
        loop_name    TEXT,
        session_id   TEXT,
        content      TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
        CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
        UNIQUE (project_id, loop_name),
        UNIQUE (project_id, session_id)
      )
    `)

    db.exec(`
      CREATE TABLE review_findings (
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL DEFAULT '',
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT,
        created_at INTEGER NOT NULL,
        section_index INTEGER,
        PRIMARY KEY (project_id, loop_name, file, line, section_index)
      )
    `)

    db.exec(`
      CREATE TABLE section_plans (
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL,
        section_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER,
        summary_done TEXT,
        summary_deviations TEXT,
        summary_follow_ups TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, loop_name, section_index)
      )
    `)

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)

    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      { log: () => {}, error: () => {}, debug: () => {} },
      undefined,
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
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      decompositionStatus: 'completed',
      decompositionMode: 'deterministic',
      decompositionSessionId: null,
      currentSectionIndex: 0,
      totalSections: 2,
      finalAuditDone: false,
      finalAuditAttempts: 0,
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

  function createHandler(v2Client?: OpencodeClient) {
    const clientState: MockClientState = { deleteCalls: [], publishCalls: [], deleteThrows: false }
    const mockClient = v2Client ?? createMockV2Client(clientState)
    const { logger } = createCapturingLogger()

    return createLoopEventHandler(
      loopService,
      { client: {} as any },
      mockClient,
      logger,
      () => mockConfig,
      undefined,
      PROJECT_ID,
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
