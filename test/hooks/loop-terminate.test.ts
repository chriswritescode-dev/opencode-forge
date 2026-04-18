import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createLoopService, type LoopState } from '../../src/services/loop'
import { createLoopEventHandler } from '../../src/hooks/loop'
import type { Logger, PluginConfig } from '../../src/types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

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

function createCapturingLogger(): { logger: Logger; errors: Array<{ msg: string; err?: unknown }> } {
  const errors: Array<{ msg: string; err?: unknown }> = []
  const logger: Logger = {
    log: () => {},
    error: (msg: string, err?: unknown) => { errors.push({ msg, err }) },
    debug: () => {},
  }
  return { logger, errors }
}

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    model: 'test/loop',
    defaultMaxIterations: 5,
  },
}

describe('Loop Terminate Handler', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-terminate-test-'))
    const dbPath = join(tempDir, 'loop-terminate-test.db')
    db = new Database(dbPath)

    db.run(`
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
        audit                INTEGER NOT NULL,
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
        PRIMARY KEY (project_id, loop_name)
      )
    `)

    db.run(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
        prompt              TEXT,
        last_audit_result   TEXT,
        PRIMARY KEY (project_id, loop_name),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    db.run(`
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

    db.run(`
      CREATE TABLE review_findings (
        project_id TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT NOT NULL,
        branch TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, file, line)
      )
    `)

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)

    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, { log: () => {}, error: () => {}, debug: () => {} })
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  function makeState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: 'loop-session-id',
      loopName: 'test-loop',
      worktreeDir: '/tmp/nonexistent-worktree-for-test',
      projectDir: '/tmp/host-project-dir',
      worktreeBranch: 'test/branch',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding',
      audit: true,
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      ...overrides,
    }
  }

  describe('session.delete on cancelled termination (worktree loop)', () => {
    test('calls session.delete with loop sessionID and host projectDir', async () => {
      const state = makeState()
      loopService.setState(state.loopName, state)

      const clientState: MockClientState = { deleteCalls: [], publishCalls: [], deleteThrows: false }
      const v2Client = createMockV2Client(clientState)
      const { logger } = createCapturingLogger()

      const handler = createLoopEventHandler(
        loopService,
        { client: {} as any },
        v2Client,
        logger,
        () => mockConfig,
        undefined,
        projectId,
        tempDir,
      )

      const cancelled = await handler.cancelBySessionId(state.sessionId)
      expect(cancelled).toBe(true)

      expect(clientState.deleteCalls).toHaveLength(1)
      expect(clientState.deleteCalls[0]).toEqual({
        sessionID: state.sessionId,
        directory: state.projectDir!,
      })
    })

    test('publishes toast on host projectDir, not the removed worktreeDir', async () => {
      const state = makeState()
      loopService.setState(state.loopName, state)

      const clientState: MockClientState = { deleteCalls: [], publishCalls: [], deleteThrows: false }
      const v2Client = createMockV2Client(clientState)
      const { logger } = createCapturingLogger()

      const handler = createLoopEventHandler(
        loopService,
        { client: {} as any },
        v2Client,
        logger,
        () => mockConfig,
        undefined,
        projectId,
        tempDir,
      )

      await handler.cancelBySessionId(state.sessionId)

      expect(clientState.publishCalls).toHaveLength(1)
      expect(clientState.publishCalls[0].directory).toBe(state.projectDir!)
      expect(clientState.publishCalls[0].directory).not.toBe(state.worktreeDir)
    })

    test('logs error but does not throw when session.delete fails', async () => {
      const state = makeState()
      loopService.setState(state.loopName, state)

      const clientState: MockClientState = { deleteCalls: [], publishCalls: [], deleteThrows: true }
      const v2Client = createMockV2Client(clientState)
      const { logger, errors } = createCapturingLogger()

      const handler = createLoopEventHandler(
        loopService,
        { client: {} as any },
        v2Client,
        logger,
        () => mockConfig,
        undefined,
        projectId,
        tempDir,
      )

      await expect(handler.cancelBySessionId(state.sessionId)).resolves.toBe(true)

      expect(clientState.deleteCalls).toHaveLength(1)
      const deleteFailureLog = errors.find(e => e.msg.includes('failed to delete loop session'))
      expect(deleteFailureLog).toBeTruthy()
    })
  })

  describe('session.delete skipped for non-worktree loops', () => {
    test('in-place (worktree=false) cancelled loop does not call session.delete', async () => {
      const state = makeState({ worktree: false })
      loopService.setState(state.loopName, state)

      const clientState: MockClientState = { deleteCalls: [], publishCalls: [], deleteThrows: false }
      const v2Client = createMockV2Client(clientState)
      const { logger } = createCapturingLogger()

      const handler = createLoopEventHandler(
        loopService,
        { client: {} as any },
        v2Client,
        logger,
        () => mockConfig,
        undefined,
        projectId,
        tempDir,
      )

      const cancelled = await handler.cancelBySessionId(state.sessionId)
      expect(cancelled).toBe(true)

      expect(clientState.deleteCalls).toHaveLength(0)
    })
  })

  describe('hostSessionId persistence through termination', () => {
    test('hostSessionId on loop row is preserved after termination', async () => {
      const hostSessionId = 'host-session-abc'
      const state = makeState({ hostSessionId })
      loopService.setState(state.loopName, state)

      const clientState: MockClientState = { deleteCalls: [], publishCalls: [], deleteThrows: false }
      const v2Client = createMockV2Client(clientState)
      const { logger } = createCapturingLogger()

      const handler = createLoopEventHandler(
        loopService,
        { client: {} as any },
        v2Client,
        logger,
        () => mockConfig,
        undefined,
        projectId,
        tempDir,
      )

      await handler.cancelBySessionId(state.sessionId)

      const after = loopService.getAnyState(state.loopName)
      expect(after).toBeTruthy()
      expect(after!.hostSessionId).toBe(hostSessionId)
      expect(after!.active).toBe(false)
      expect(after!.terminationReason).toBe('cancelled')
    })
  })
})
