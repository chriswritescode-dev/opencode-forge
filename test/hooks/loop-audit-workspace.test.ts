import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createLoopService } from '../../src/services/loop'
import type { Logger } from '../../src/types'
import type { LoopState } from '../../src/services/loop'

interface MockV2Client {
  session: {
    create: ReturnType<typeof mock<(params: any) => Promise<{ data?: { id: string }; error?: unknown }>>>
    promptAsync: ReturnType<typeof mock<(params: any) => Promise<{ data?: unknown; error?: unknown }>>>
    delete: ReturnType<typeof mock<(params: any) => Promise<void>>>
    get: ReturnType<typeof mock<(params: any) => Promise<{ data?: { permission?: unknown }; error?: unknown }>>>
    messages: ReturnType<typeof mock<(params: any) => Promise<{ data?: any[]; error?: unknown }>>>
  }
  experimental: {
    workspace: {
      create: ReturnType<typeof mock<(params: any) => Promise<{ data?: { id: string }; error?: unknown }>>>
      warp: ReturnType<typeof mock<(params: any) => Promise<{ data?: unknown; error?: unknown }>>>
    }
  }
  tui?: {
    selectSession: ReturnType<typeof mock<(params: any) => Promise<void>>>
    publish: ReturnType<typeof mock<(params: any) => Promise<void>>>
  }
}

interface MockClient {
  session: {
    create: ReturnType<typeof mock<(params: any) => Promise<{ data?: { id: string } }>>>
  }
}

function createMockV2Client(): MockV2Client {
  return {
    session: {
      create: mock(() => Promise.resolve({ data: { id: 'sess_mock_123' } })),
      promptAsync: mock(() => Promise.resolve({ data: {} })),
      delete: mock(() => Promise.resolve()),
      get: mock(() => Promise.resolve({ data: { permission: {} } })),
      messages: mock(() => Promise.resolve({ data: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'test' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'response' }] },
      ] })),
    },
    experimental: {
      workspace: {
        create: mock(() => Promise.resolve({ data: { id: 'ws_test_123' } })),
        warp: mock(() => Promise.resolve({ data: {} })),
      },
    },
    tui: {
      selectSession: mock(() => Promise.resolve()),
      publish: mock(() => Promise.resolve()),
    },
  }
}

function createMockClient(): MockClient {
  return {
    session: {
      create: mock(() => Promise.resolve({ data: { id: 'sess_mock_123' } })),
    },
  }
}

describe('ensureWorkspaceForLoop - audit path', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  let mockV2: MockV2Client
  let mockClient: MockClient
  const projectId = 'test-project'

  const mockLogger: Logger = {
    log: mock(),
    error: mock(),
    debug: mock(),
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-audit-workspace-test-'))
    const dbPath = join(tempDir, 'loop-audit-workspace-test.db')
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
        loop_name TEXT NOT NULL DEFAULT '',
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, loop_name, file, line)
      )
    `)

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)

    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)
    mockV2 = createMockV2Client()
    mockClient = createMockClient()
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup
    }
    mock(mockLogger.log).mockClear()
    mock(mockLogger.error).mockClear()
  })

  test('worktree loop with undefined workspaceId: provisions workspace before audit', async () => {
    const loopName = 'test-worktree-loop'
    const worktreeDir = join(tempDir, 'worktree')
    
    const state: LoopState = {
      active: true,
      sessionId: 'sess_code_123',
      loopName,
      worktreeDir,
      projectDir: '/tmp/project',
      worktreeBranch: 'feature-branch',
      iteration: 1,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test/test-model',
      auditorModel: 'test/test-auditor',
    }

    loopService.setState(loopName, state)
    loopService.registerLoopSession('sess_code_123', loopName)

    const { createLoopEventHandler } = await import('../../src/hooks/loop')
    const handler = createLoopEventHandler(
      loopService,
      mockClient as any,
      mockV2 as any,
      mockLogger,
      () => ({ loop: { model: 'test/test-model' } }),
      undefined,
      projectId,
      tempDir,
    )

    await handler.onEvent({
      event: {
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: 'sess_code_123',
        },
      },
    })

    const currentState = loopService.getActiveState(loopName)
    expect(currentState?.workspaceId).toBe('ws_test_123')
    expect(mockV2.experimental.workspace.create).toHaveBeenCalled()
    const createCall = (mockV2.experimental.workspace.create as any).mock.calls[0][0]
    expect(createCall.type).toBe('forge-worktree')
    
    const sessionCreateCall = (mockV2.session.create as any).mock.calls[0][0]
    expect(sessionCreateCall.workspaceID).toBe('ws_test_123')
  })

  test('in-place loop: does not provision workspace', async () => {
    const loopName = 'test-inplace-loop'
    
    const state: LoopState = {
      active: true,
      sessionId: 'sess_code_123',
      loopName,
      worktreeDir: '/tmp/project',
      projectDir: '/tmp/project',
      iteration: 1,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: false,
      sandbox: false,
      executionModel: 'test/test-model',
      auditorModel: 'test/test-auditor',
    }

    loopService.setState(loopName, state)
    loopService.registerLoopSession('sess_code_123', loopName)

    const { createLoopEventHandler } = await import('../../src/hooks/loop')
    const handler = createLoopEventHandler(
      loopService,
      mockClient as any,
      mockV2 as any,
      mockLogger,
      () => ({ loop: { model: 'test/test-model' } }),
      undefined,
      projectId,
      tempDir,
    )

    await handler.onEvent({
      event: {
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: 'sess_code_123',
        },
      },
    })

    expect(mockV2.experimental.workspace.create).not.toHaveBeenCalled()
    const sessionCreateCall = (mockV2.session.create as any).mock.calls[0][0]
    expect(sessionCreateCall).not.toHaveProperty('workspaceID')
  })

  test('workspace creation fails: audit proceeds without workspace', async () => {
    const loopName = 'test-fail-workspace'
    const worktreeDir = join(tempDir, 'worktree')
    
    mockV2.experimental.workspace.create = mock(() => 
      Promise.resolve({ error: new Error('workspace API unavailable') })
    )

    const state: LoopState = {
      active: true,
      sessionId: 'sess_code_123',
      loopName,
      worktreeDir,
      projectDir: '/tmp/project',
      worktreeBranch: 'feature-branch',
      iteration: 1,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test/test-model',
      auditorModel: 'test/test-auditor',
    }

    loopService.setState(loopName, state)
    loopService.registerLoopSession('sess_code_123', loopName)

    const { createLoopEventHandler } = await import('../../src/hooks/loop')
    const handler = createLoopEventHandler(
      loopService,
      mockClient as any,
      mockV2 as any,
      mockLogger,
      () => ({ loop: { model: 'test/test-model' } }),
      undefined,
      projectId,
      tempDir,
    )

    await handler.onEvent({
      event: {
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: 'sess_code_123',
        },
      },
    })

    const currentState = loopService.getActiveState(loopName)
    expect(currentState?.workspaceId).toBeUndefined()
    const sessionCreateCall = (mockV2.session.create as any).mock.calls[0][0]
    expect(sessionCreateCall).not.toHaveProperty('workspaceID')
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('workspace creation failed'),
    )
  })
})
