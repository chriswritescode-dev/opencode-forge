import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { createLoopService } from '../src/services/loop'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopTools } from '../src/tools/loop'
import { createLogger } from '../src/utils/logger'
import { createLoopEventHandler } from '../src/hooks/loop'

const TEST_DIR = '/tmp/opencode-loop-status-test-' + Date.now()

function createTestDb(): { db: Database; path: string } {
  const path = `${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`
  const db = new Database(path)
  db.run(`
    CREATE TABLE IF NOT EXISTS loops (
      project_id TEXT NOT NULL,
      loop_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id TEXT NOT NULL,
      worktree INTEGER NOT NULL,
      worktree_dir TEXT NOT NULL,
      worktree_branch TEXT,
      project_dir TEXT NOT NULL,
      max_iterations INTEGER NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      audit_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL CHECK(phase IN ('coding','auditing')),
      execution_model TEXT,
      auditor_model TEXT,
      model_failed INTEGER NOT NULL DEFAULT 0,
      sandbox INTEGER NOT NULL DEFAULT 0,
      sandbox_container TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      termination_reason TEXT,
      completion_summary TEXT,
      workspace_id         TEXT,
      host_session_id      TEXT,
      session_directory    TEXT,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS loop_large_fields (
      project_id TEXT NOT NULL,
      loop_name TEXT NOT NULL,
      prompt TEXT,
      last_audit_result TEXT,
      PRIMARY KEY (project_id, loop_name),
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS plans (
      project_id TEXT NOT NULL,
      session_id TEXT,
      loop_name TEXT,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS review_findings (
      project_id TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      severity TEXT NOT NULL,
      description TEXT NOT NULL,
      scenario TEXT,
      branch TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, file, line)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(project_id, status)`)
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_session ON loops(project_id, current_session_id)`)
  return { db, path }
}

function createMockV2Client(overrides?: Partial<OpencodeClient>): OpencodeClient {
  return {
    session: {
      create: mock(async (params) => {
        return {
          data: { id: 'mock-session-' + Date.now(), title: params.title },
          error: null,
        }
      }),
      promptAsync: mock(async () => ({ data: {}, error: null })),
      abort: mock(async () => ({ data: {}, error: null })),
      status: mock(async () => ({ data: {}, error: null })),
      delete: mock(async () => ({ data: {}, error: null })),
      messages: mock(async () => ({ data: [], error: null })),
      get: mock(async () => ({ data: {}, error: null })),
    },
    worktree: {
      create: mock(async () => ({ data: { name: 'mock', directory: '/tmp/mock', branch: 'main' }, error: null })),
      remove: mock(async () => ({ data: {}, error: null })),
    },
    experimental: {
      workspace: {
        create: mock(async () => ({ data: { id: 'mock-workspace-' + Date.now() }, error: null })),
        sessionRestore: mock(async () => ({ data: {}, error: null })),
      },
    },
    tui: {
      selectSession: mock(async () => ({ data: {}, error: null })),
      publish: mock(async () => ({ data: {}, error: null })),
    },
    ...overrides,
  } as unknown as OpencodeClient
}

function createMockTuiApi(overrides?: Partial<TuiPluginApi>): TuiPluginApi {
  return {
    client: createMockV2Client(),
    state: {
      path: {
        directory: TEST_DIR,
      },
    },
    ui: {
      toast: mock(() => {}),
      dialog: {
        clear: mock(() => {}),
        replace: mock(() => {}),
        setSize: mock(() => {}),
      },
    },
    theme: {
      current: {
        text: 'white',
        textMuted: 'gray',
        border: 'blue',
        info: 'cyan',
        success: 'green',
        warning: 'yellow',
        error: 'red',
        markdownText: 'white',
      },
    },
    route: {
      navigate: mock(() => {}),
      current: { name: 'session', params: {} },
    },
    event: {
      on: mock(() => () => {}),
    },
    app: {
      version: 'local',
    },
    ...overrides,
  } as TuiPluginApi
}

describe('loop-status tool restart path', () => {
  let db: Database
  let dbPath: string
  const projectId = 'test-project'
  const loopName = 'test-loop'
  const workspaceId = 'mock-workspace-123'
  const hostSessionId = 'host-session-456'

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    dbPath = result.path
  })

  afterEach(() => {
    db.close()
  })

  test('force-restart preserves workspaceId and hostSessionId', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    // Seed a running worktree loop with workspace metadata
    const oldSessionId = 'old-session-123'
    const worktreeDir = `${TEST_DIR}/worktree`
    
    loopService.setState(loopName, {
      active: true,
      sessionId: oldSessionId,
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-loop',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'auditing',

      errorCount: 0,
      auditCount: 1,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId,
      hostSessionId,
    })
    
    const loopHandler = createLoopEventHandler(loopService, mockApi, v2Client, logger, () => ({}), undefined, projectId, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      projectId,
      dataDir: dbPath,
    } as any)
    
    // Invoke force-restart
    const result = await tools['loop-status'].execute({
      name: loopName,
      restart: true,
      force: true,
    }, { sessionID: 'test-session' } as any)
    
    // Assert result mentions restart
    expect(result).toContain('Restarted loop')
    
    // Verify new session was created with workspaceID
    const createCalls = (v2Client.session.create as ReturnType<typeof mock>).mock.calls
    expect(createCalls.length).toBeGreaterThan(0)
    const lastCreateCall = createCalls[createCalls.length - 1][0]
    expect(lastCreateCall).toMatchObject({
      title: loopName,
      directory: worktreeDir,
      workspaceID: workspaceId,
    })
    
    // Verify workspace binding was called
    expect(v2Client.experimental?.workspace?.sessionRestore).toHaveBeenCalledWith({
      id: workspaceId,
      sessionID: expect.any(String),
    })
    
    // Verify persisted state retains workspaceId and hostSessionId
    const newState = loopService.getActiveState(loopName)
    expect(newState).toBeDefined()
    expect(newState?.workspaceId).toBe(workspaceId)
    expect(newState?.hostSessionId).toBe(hostSessionId)
  })

  test('force-restart during auditing phase prevents double-rotation', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const oldSessionId = 'old-session-456'
    const worktreeDir = `${TEST_DIR}/worktree2`
    
    loopService.setState(loopName, {
      active: true,
      sessionId: oldSessionId,
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-loop2',
      iteration: 1,
      maxIterations: 3,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt 2',
      phase: 'auditing',

      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
    })
    
    const loopHandler = createLoopEventHandler(loopService, mockApi, v2Client, logger, () => ({}), undefined, projectId, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      projectId,
      dataDir: dbPath,
    } as any)
    
    // Start force-restart
    const restartPromise = tools['loop-status'].execute({
      name: loopName,
      restart: true,
      force: true,
    }, { sessionID: 'test-session' } as any)
    
    // Wait for restart to complete
    await restartPromise
    
    // Verify only one new session was created (not multiple)
    const createCalls = (v2Client.session.create as ReturnType<typeof mock>).mock.calls
    // Should have exactly one create call for the restart
    expect(createCalls.length).toBe(1)
    
    // Verify old session was unregistered
    const resolvedOld = loopService.resolveLoopName(oldSessionId)
    expect(resolvedOld).toBeNull()
  })

  test('force-restart clears workspaceId but preserves hostSessionId when bind fails', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)

    // Seed a running worktree loop with workspace metadata
    const oldSessionId = 'old-session-bindfail'
    const worktreeDir = `${TEST_DIR}/worktree-bindfail`

    loopService.setState(loopName, {
      active: true,
      sessionId: oldSessionId,
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-bindfail',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'auditing',

      errorCount: 0,
      auditCount: 1,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId,
      hostSessionId,
    })

    // Override sessionRestore to throw
    ;(v2Client.experimental!.workspace!.sessionRestore as ReturnType<typeof mock>) = mock(async () => {
      throw new Error('workspace gone')
    })

    const toastCalls: Array<{ variant?: string; message?: string }> = []
    ;(v2Client.tui!.publish as ReturnType<typeof mock>) = mock(async (opts: any) => {
      const props = opts?.body?.properties ?? {}
      toastCalls.push({ variant: props.variant, message: props.message })
      return { data: {}, error: null }
    })

    const loopHandler = createLoopEventHandler(loopService, mockApi, v2Client, logger, () => ({}), undefined, projectId, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      projectId,
      dataDir: dbPath,
    } as any)

    const result = await tools['loop-status'].execute({
      name: loopName,
      restart: true,
      force: true,
    }, { sessionID: 'test-session' } as any)

    expect(result).toContain('Restarted loop')

    const newState = loopService.getActiveState(loopName)
    expect(newState).toBeDefined()
    // workspaceId is cleared because bind failed
    expect(newState?.workspaceId).toBeUndefined()
    // hostSessionId is preserved so post-completion TUI redirect still works
    expect(newState?.hostSessionId).toBe(hostSessionId)
    expect(newState?.active).toBe(true)

    // A warning toast should have been surfaced
    const warningToasts = toastCalls.filter((t) => t.variant === 'warning')
    expect(warningToasts.length).toBeGreaterThan(0)
    expect(warningToasts[0].message).toContain('Workspace attachment lost')
  })

  test('non-force restart (inactive loop) preserves metadata', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const oldSessionId = 'old-session-789'
    const worktreeDir = `${TEST_DIR}/worktree3`
    
    // Create an inactive loop
    loopService.setState(loopName, {
      active: false,
      sessionId: oldSessionId,
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-loop3',
      iteration: 1,
      maxIterations: 3,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      prompt: 'Test prompt 3',
      phase: 'coding',

      errorCount: 0,
      auditCount: 0,
      terminationReason: 'cancelled',
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId,
      hostSessionId,
    })
    
    const loopHandler = createLoopEventHandler(loopService, mockApi, v2Client, logger, () => ({}), undefined, projectId, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      projectId,
      dataDir: dbPath,
    } as any)
    
    // Invoke non-force restart
    const result = await tools['loop-status'].execute({
      name: loopName,
      restart: true,
      force: false,
    }, { sessionID: 'test-session' } as any)
    
    expect(result).toContain('Restarted loop')
    
    // Verify new state has workspace metadata
    const newState = loopService.getActiveState(loopName)
    expect(newState?.workspaceId).toBe(workspaceId)
    expect(newState?.hostSessionId).toBe(hostSessionId)
  })
})
