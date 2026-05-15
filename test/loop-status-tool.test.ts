import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'fs'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { createLoopService } from '../src/loop/service'
import type { LoopState } from '../src/loop/state'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopTools } from '../src/tools/loop'
import { createLogger } from '../src/utils/logger'
import { createLoopEventHandler } from '../src/hooks/loop'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../src/constants/loop'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const TEST_DIR = '/tmp/opencode-loop-status-test-' + Date.now()

function createTestDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `forge-test-${randomUUID()}.db`)
  const db = new Database(path)

  db.exec(`
CREATE TABLE IF NOT EXISTS loops (
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
  decomposition_status TEXT NOT NULL DEFAULT 'pending',
  decomposition_mode   TEXT NOT NULL DEFAULT 'agent',
  decomposition_session_id TEXT,
  current_section_index INTEGER NOT NULL DEFAULT 0,
  total_sections       INTEGER NOT NULL DEFAULT 0,
  final_audit_done     INTEGER NOT NULL DEFAULT 0,
  final_audit_attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, loop_name)
)`)

  db.exec(`
CREATE TABLE IF NOT EXISTS loop_large_fields (
  project_id          TEXT NOT NULL,
  loop_name           TEXT NOT NULL,
  last_audit_result   TEXT,
  PRIMARY KEY (project_id, loop_name),
  FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
)`)

  db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  project_id   TEXT NOT NULL,
  loop_name    TEXT,
  session_id   TEXT,
  content      TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
  CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
  UNIQUE (project_id, loop_name),
  UNIQUE (project_id, session_id)
)`)

  db.exec(`
CREATE TABLE IF NOT EXISTS review_findings (
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
)`)

  return { db, path }
}

function createMockV2Client(overrides?: Partial<OpencodeClient>): OpencodeClient {
  return {
    session: {
      create: vi.fn(async (params) => ({
        data: { id: 'mock-session-' + Date.now(), title: params.title },
        error: null,
      })),
      promptAsync: vi.fn(async () => ({ data: {}, error: null })),
      abort: vi.fn(async () => ({ data: {}, error: null })),
      status: vi.fn(async () => ({ data: {}, error: null })),
      delete: vi.fn(async () => ({ data: {}, error: null })),
      messages: vi.fn(async () => ({ data: [], error: null })),
      get: vi.fn(async () => ({ data: {}, error: null })),
    },
    worktree: {
      create: vi.fn(async () => ({ data: { name: 'mock', directory: '/tmp/mock', branch: 'main' }, error: null })),
      remove: vi.fn(async () => ({ data: {}, error: null })),
    },
    experimental: {
      workspace: {
        create: vi.fn(async () => ({ data: { id: 'mock-workspace-' + Date.now() }, error: null })),
        warp: vi.fn(async () => ({ data: {}, error: null })),
      },
    },
    tui: {
      selectSession: vi.fn(async () => ({ data: {}, error: null })),
      publish: vi.fn(async () => ({ data: {}, error: null })),
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
      toast: vi.fn(() => {}),
      dialog: {
        clear: vi.fn(() => {}),
        replace: vi.fn(() => {}),
        setSize: vi.fn(() => {}),
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
      navigate: vi.fn(() => {}),
      current: { name: 'session', params: {} },
    },
    event: {
      on: vi.fn(() => () => {}),
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

  function makeState(active: boolean): Partial<LoopState> & Pick<LoopState, 'sessionId' | 'loopName' | 'worktreeDir' | 'projectDir'> {
    return {
      active,
      sessionId: active ? 'old-session-active' : 'old-session-done',
      loopName,
      worktreeDir: `${TEST_DIR}/worktree`,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-loop',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: active ? 'auditing' : ('coding' as const),
      errorCount: 0,
      auditCount: active ? 1 : 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId,
      hostSessionId,
      decompositionStatus: 'completed' as const,
      decompositionMode: 'deterministic' as const,
      decompositionSessionId: null,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
    }
  }

  test('force-restart preserves workspaceId and hostSessionId', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    // Seed a running worktree loop with workspace metadata
    const oldSessionId = 'old-session-123'
    const worktreeDir = `${TEST_DIR}/worktree`
    mkdirSync(worktreeDir, { recursive: true })
    
    loopService.setState(loopName, {
      ...makeState(true),
      sessionId: oldSessionId,
    } as LoopState)
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
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
    const createCalls = ((v2Client.session.create as any)).mock.calls
    expect(createCalls.length).toBeGreaterThan(0)
    const lastCreateCall = createCalls[createCalls.length - 1][0]
    expect(lastCreateCall.directory).toBe(worktreeDir)
    expect(lastCreateCall.workspaceID).toBe(workspaceId)
    expect(lastCreateCall.title).toContain(loopName)
    expect(lastCreateCall).not.toHaveProperty('parentID')
    
    // Verify workspace binding was called
    expect((v2Client.experimental?.workspace?.warp as any)).toHaveBeenCalledWith({
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
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const oldSessionId = 'old-session-456'
    const worktreeDir = `${TEST_DIR}/worktree2`
    mkdirSync(worktreeDir, { recursive: true })
    
    loopService.setState(loopName, {
      ...makeState(true),
      sessionId: oldSessionId,
      iteration: 1,
      maxIterations: 3,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt 2',
      phase: 'auditing',
      auditCount: 0,
      worktreeBranch: 'opencode/loop-test-loop2',
    } as LoopState)
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
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
    const createCalls = ((v2Client.session.create as any)).mock.calls
    // Should have exactly one create call for the restart
    expect(createCalls.length).toBe(1)
    const createArgs = createCalls[0][0]
    expect(createArgs).not.toHaveProperty('parentID')
    
    // Verify old session was unregistered
    const resolvedOld = loopService.resolveLoopName(oldSessionId)
    expect(resolvedOld).toBeNull()
  })

  test('force-restart clears workspaceId but preserves hostSessionId when bind fails', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)

    // Seed a running worktree loop with workspace metadata
    const oldSessionId = 'old-session-bindfail'
    const worktreeDir = `${TEST_DIR}/worktree-bindfail`
    mkdirSync(worktreeDir, { recursive: true })

    loopService.setState(loopName, {
      ...makeState(true),
      sessionId: oldSessionId,
      worktreeBranch: 'opencode/loop-test-bindfail',
      worktreeDir,
    } as LoopState)

    // Override warp to throw
    ;(v2Client.experimental!.workspace!.warp as any) = vi.fn(async () => {
      throw new Error('workspace gone')
    })

    const toastCalls: Array<{ variant?: string; message?: string }> = []
    ;(v2Client.tui!.publish as any) = vi.fn(async (opts: any) => {
      const props = opts?.body?.properties ?? {}
      toastCalls.push({ variant: props.variant, message: props.message })
      return { data: {}, error: null }
    })

    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
    } as any)

    const result = await tools['loop-status'].execute({
      name: loopName,
      restart: true,
      force: true,
    }, { sessionID: 'test-session' } as any)

    expect(result).toContain('Restarted loop')

    const createCalls = ((v2Client.session.create as any)).mock.calls
    expect(createCalls.length).toBeGreaterThan(0)
    const createArgs = createCalls[0][0]
    expect(createArgs).not.toHaveProperty('parentID')

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
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const oldSessionId = 'old-session-789'
    const worktreeDir = `${TEST_DIR}/worktree3`
    mkdirSync(worktreeDir, { recursive: true })
    
    // Create an inactive loop
    loopService.setState(loopName, {
      ...makeState(false),
      sessionId: oldSessionId,
      completedAt: new Date().toISOString(),
      terminationReason: 'cancelled',
    } as LoopState)
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
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
    
    // Verify restart session was created without parentID
    const createCalls = ((v2Client.session.create as any)).mock.calls
    expect(createCalls.length).toBeGreaterThan(0)
    const createArgs = createCalls[0][0]
    expect(createArgs).not.toHaveProperty('parentID')
  })

  test('force-restart agent decomposer without workspace includes permission ruleset', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)

    const oldSessionId = 'old-session-decomposer-agent-noworkspace'
    const worktreeDir = `${TEST_DIR}/worktree-decomposer-agent`
    mkdirSync(worktreeDir, { recursive: true })

    loopService.setState(loopName, {
      active: false,
      sessionId: oldSessionId,
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-decomposer-agent',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt for agent decomposer restart without workspace',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId: undefined,
      hostSessionId,
      decompositionStatus: 'failed',
      decompositionMode: 'agent',
      decompositionSessionId: null,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      terminationReason: 'decomposition_failed',
      completedAt: new Date().toISOString(),
    } as LoopState)

    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
    } as any)

    await tools['loop-status'].execute({
      name: loopName,
      restart: true,
      force: true,
    }, { sessionID: 'test-session' } as any)

    const createCalls = ((v2Client.session.create as any)).mock.calls
    expect(createCalls.length).toBeGreaterThan(0)

    // Find the session.create call that has permission property
    const callWithPermission = createCalls.find((call: any[]) =>
      call[0]?.permission !== undefined
    )
    expect(callWithPermission).toBeDefined()
    expect(callWithPermission![0].permission).toEqual(buildLoopPermissionRuleset())
  })

  test('force-restart deterministic-to-agent fallback without workspace includes permission ruleset', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)

    const oldSessionId = 'old-session-deterministic-fallback-noworkspace'
    const worktreeDir = `${TEST_DIR}/worktree-deterministic-fallback`
    mkdirSync(worktreeDir, { recursive: true })

    // Seed inactive loop with deterministic decomposition that failed
    loopService.setState(loopName, {
      active: false,
      sessionId: oldSessionId,
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-deterministic-fallback',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      // Empty plan text so deterministic parser yields no sections
      prompt: '',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId: undefined,
      hostSessionId,
      decompositionStatus: 'failed',
      decompositionMode: 'deterministic',
      decompositionSessionId: null,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      terminationReason: 'decomposition_failed',
      completedAt: new Date().toISOString(),
    } as LoopState)

    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: { decomposer: { enabled: true, mode: 'deterministic', onParseFailure: 'agent', maxSections: 12 } },
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
    } as any)

    await tools['loop-status'].execute({
      name: loopName,
      restart: true,
      force: true,
    }, { sessionID: 'test-session' } as any)

    const createCalls = ((v2Client.session.create as any)).mock.calls
    expect(createCalls.length).toBeGreaterThan(0)

    // Find the fallback decomposer session.create call (has decomposer- title prefix)
    const decomposerCall = createCalls.find((call: any[]) =>
      typeof call[0]?.title === 'string' && call[0].title.startsWith('decomposer-')
    )
    expect(decomposerCall).toBeDefined()
    expect(decomposerCall![0]).toHaveProperty('permission')
    expect(decomposerCall![0].permission).toEqual(buildLoopPermissionRuleset())
  })

  test('non-force restart of final_audit_retry_exhausted returns conflict', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)

    const oldSessionId = 'old-session-final-audit-exhausted'
    const worktreeDir = `${TEST_DIR}/worktree-final-audit-exhausted`
    mkdirSync(worktreeDir, { recursive: true })

    loopService.setState(loopName, {
      active: false,
      sessionId: oldSessionId,
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-final-audit-exhausted',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'final_auditing',
      errorCount: 0,
      auditCount: 1,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId,
      hostSessionId,
      decompositionStatus: 'completed',
      decompositionMode: 'deterministic',
      decompositionSessionId: null,
      currentSectionIndex: 1,
      totalSections: 2,
      finalAuditDone: false,
      terminationReason: 'final_audit_retry_exhausted',
      completedAt: new Date().toISOString(),
    } as LoopState)

    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
    } as any)

    const result = await tools['loop-status'].execute({
      name: loopName,
      restart: true,
      force: false,
    }, { sessionID: 'test-session' } as any)

    expect(result).toContain('terminated during final audit retry exhaustion')
    expect(result).toContain('Use force=true to restart')

    // No new session.create should have been called
    const createCalls = ((v2Client.session.create as any)).mock.calls
    expect(createCalls.length).toBe(0)

    // Loop should remain inactive
    const state = loopService.getActiveState(loopName)
    expect(state).toBeNull()
  })

  test('forced restart of final_audit_retry_exhausted resumes at final_auditing', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)

    const oldSessionId = 'old-session-final-audit-force'
    const worktreeDir = `${TEST_DIR}/worktree-final-audit-force`
    mkdirSync(worktreeDir, { recursive: true })

    loopService.setState(loopName, {
      active: false,
      sessionId: oldSessionId,
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-final-audit-force',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt for forced final audit restart',
      phase: 'final_auditing',
      errorCount: 0,
      auditCount: 1,
      worktree: true,
      sandbox: false,
      executionModel: 'provider/execution-model',
      auditorModel: 'provider/auditor-model',
      workspaceId,
      hostSessionId,
      decompositionStatus: 'completed',
      decompositionMode: 'deterministic',
      decompositionSessionId: null,
      currentSectionIndex: 1,
      totalSections: 2,
      finalAuditDone: false,
      terminationReason: 'final_audit_retry_exhausted',
      completedAt: new Date().toISOString(),
    } as LoopState)

    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath)
    const tools = createLoopTools({
      v2: v2Client,
      directory: TEST_DIR,
      config: {},
      loopService,
      loopHandler,
      logger,
      plansRepo,
      loopsRepo,
      projectId,
      dataDir: dbPath,
      loop: loopHandler.loop,
    } as any)

    const result = await tools['loop-status'].execute({
      name: loopName,
      restart: true,
      force: true,
    }, { sessionID: 'test-session' } as any)

    expect(result).toContain('Restarted loop')

    // Verify persisted state
    const newState = loopService.getActiveState(loopName)
    expect(newState).toBeDefined()
    expect(newState?.active).toBe(true)
    expect(newState?.phase).toBe('final_auditing')
    expect(newState?.terminationReason).toBeFalsy()
    expect(newState?.completedAt).toBeFalsy()
    expect(newState?.currentSectionIndex).toBe(1)
    expect(newState?.totalSections).toBe(2)
    expect(newState?.finalAuditDone).toBe(false)

    // Verify promptAsync was called with auditor-loop agent using auditor model
    const promptCalls = ((v2Client.session.promptAsync as any)).mock.calls
    expect(promptCalls.length).toBeGreaterThan(0)
    const lastPromptCall = promptCalls[promptCalls.length - 1][0]
    expect(lastPromptCall.agent).toBe('auditor-loop')
    expect(lastPromptCall.model).toEqual({ providerID: 'provider', modelID: 'auditor-model' })

    // Verify session creation uses audit permissions, not loop permissions
    const createCalls = ((v2Client.session.create as any)).mock.calls
    expect(createCalls.length).toBeGreaterThan(0)
    const callWithPermission = createCalls.find((call: any[]) =>
      call[0]?.permission !== undefined
    )
    expect(callWithPermission).toBeDefined()
    expect(callWithPermission![0].permission).toEqual(buildAuditSessionPermissionRuleset())
  })
})
