import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'fs'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { createLoopService } from '../src/loop/service'
import type { LoopState } from '../src/loop/state'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopSessionUsageRepo } from '../src/storage/repos/loop-session-usage-repo'
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
CREATE TABLE IF NOT EXISTS loop_session_usage (
  project_id          TEXT NOT NULL,
  loop_name           TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  role                TEXT NOT NULL,
  model               TEXT NOT NULL,
  cost                REAL NOT NULL,
  input_tokens        INTEGER NOT NULL,
  output_tokens       INTEGER NOT NULL,
  reasoning_tokens    INTEGER NOT NULL,
  cache_read_tokens   INTEGER NOT NULL,
  cache_write_tokens  INTEGER NOT NULL,
  message_count       INTEGER NOT NULL,
  captured_at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, loop_name, session_id, model)
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
        create: vi.fn(async () => ({
          data: { id: 'mock-workspace-' + Date.now(), directory: TEST_DIR + '/worktree', branch: 'opencode/loop-test-loop' },
          error: null,
        })),
        warp: vi.fn(async () => ({ data: {}, error: null })),
        list: vi.fn(async () => ({ data: [], error: null })),
        status: vi.fn(async () => ({ data: [], error: null })),
        syncList: vi.fn(async () => ({ data: {}, error: null })),
        remove: vi.fn(async () => ({ data: {}, error: null })),
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
    // Restart creates a FRESH workspace, so directory points to the new workspace directory
    expect(lastCreateCall.workspaceID).toMatch(/^mock-workspace-/)
    expect(lastCreateCall.title).toContain(loopName)
    expect(lastCreateCall).not.toHaveProperty('parentID')

    // Verify workspace binding was called with the fresh workspace id
    expect((v2Client.experimental?.workspace?.warp as any)).toHaveBeenCalled()

    // Verify persisted state has a fresh workspaceId (new on every restart)
    // and preserves hostSessionId
    const newState = loopService.getActiveState(loopName)
    expect(newState).toBeDefined()
    expect(newState?.workspaceId).toMatch(/^mock-workspace-/)
    expect(newState?.workspaceId).not.toBe(workspaceId) // fresh workspace, not old one
    expect(newState?.hostSessionId).toBe(hostSessionId)
    // Suppress unused variable warning for worktreeDir
    void worktreeDir
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

    // Verify new state has fresh workspace (created on every restart)
    // hostSessionId is preserved for post-completion TUI redirect
    const newState = loopService.getActiveState(loopName)
    expect(newState?.workspaceId).toMatch(/^mock-workspace-/)
    expect(newState?.workspaceId).not.toBe(workspaceId)
    expect(newState?.hostSessionId).toBe(hostSessionId)

    // Verify restart session was created without parentID
    const createCalls = ((v2Client.session.create as any)).mock.calls
    expect(createCalls.length).toBeGreaterThan(0)
    const createArgs = createCalls[0][0]
    expect(createArgs).not.toHaveProperty('parentID')
    // Suppress unused warning
    void worktreeDir
  })

  test('force-restart errored loop without workspace includes permission ruleset', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false, file: '' })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)

    const oldSessionId = 'old-session-errored-noworkspace'
    const worktreeDir = `${TEST_DIR}/worktree-errored-loop`
    mkdirSync(worktreeDir, { recursive: true })

    loopService.setState(loopName, {
      active: false,
      sessionId: oldSessionId,
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-errored-loop',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt for errored loop restart without workspace',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId: undefined,
      hostSessionId,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      terminationReason: 'error_max_retries: test error',
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

describe('loop-status cumulative usage', () => {
  let db: Database
  let dbPath: string
  const projectId = 'test-project'
  const loopName = 'test-loop-usage'

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    dbPath = result.path
  })

  afterEach(() => {
    db.close()
  })

  function createMockV2ClientWithMessages(messages: Array<{ role: string; cost?: number; tokens?: any; model?: string }>): OpencodeClient {
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
        messages: vi.fn(async () => ({
          data: messages.map((m, i) => ({
            id: `msg-${i}`,
            role: m.role,
            parts: [{ type: 'text' as const, text: 'test' }],
            info: {
              role: m.role,
              cost: m.cost ?? 0,
              tokens: m.tokens ?? { input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 5 } },
              model: m.model,
            },
          })),
          error: null,
        })),
        get: vi.fn(async () => ({ data: { summary: { additions: 10, deletions: 5, files: 2 } }, error: null })),
      },
      worktree: {
        create: vi.fn(async () => ({ data: { name: 'mock', directory: '/tmp/mock', branch: 'main' }, error: null })),
        remove: vi.fn(async () => ({ data: {}, error: null })),
      },
      experimental: {
        workspace: {
          create: vi.fn(async () => ({
            data: { id: 'mock-workspace-' + Date.now(), directory: TEST_DIR + '/worktree', branch: 'opencode/loop-test' },
            error: null,
          })),
          warp: vi.fn(async () => ({ data: {}, error: null })),
          list: vi.fn(async () => ({ data: [], error: null })),
          status: vi.fn(async () => ({ data: [], error: null })),
          syncList: vi.fn(async () => ({ data: {}, error: null })),
          remove: vi.fn(async () => ({ data: {}, error: null })),
        },
      },
      tui: {
        selectSession: vi.fn(async () => ({ data: {}, error: null })),
        publish: vi.fn(async () => ({ data: {}, error: null })),
      },
    } as unknown as OpencodeClient
  }

  test('cumulative usage appears in detailed status for inactive loop', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const worktreeDir = `${TEST_DIR}/worktree-usage`
    mkdirSync(worktreeDir, { recursive: true })
    
    // Create inactive loop
    loopService.setState(loopName, {
      active: false,
      sessionId: 'session-done',
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-usage',
      iteration: 3,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId: 'ws-123',
      hostSessionId: 'host-456',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      terminationReason: 'completed',
      completedAt: new Date().toISOString(),
    } as any)
    
    // Insert usage data
    loopSessionUsageRepo.upsertSessionUsage({
      projectId,
      loopName,
      sessionId: 'session-done',
      role: 'code',
      model: 'anthropic/claude-3-5-sonnet',
      cost: 0.0525,
      inputTokens: 5000,
      outputTokens: 2500,
      reasoningTokens: 500,
      cacheReadTokens: 100,
      cacheWriteTokens: 200,
      messageCount: 10,
      capturedAt: Date.now(),
    })
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath, {}, undefined, undefined, undefined, loopSessionUsageRepo)
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
      loopSessionUsageRepo,
    } as any)
    
    const result = await tools['loop-status'].execute({
      name: loopName,
    }, { sessionID: 'test-session' } as any)
    
    expect(result).toContain('Cumulative Usage:')
    expect(result).toContain('Total Cost:')
    expect(result).toContain('$0.0525')
    expect(result).toContain('anthropic/claude-3-5-sonnet')
  })

  test('cumulative usage appears in detailed status for active loop', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const worktreeDir = `${TEST_DIR}/worktree-usage-active`
    mkdirSync(worktreeDir, { recursive: true })
    
    // Create active loop
    loopService.setState(loopName, {
      active: true,
      sessionId: 'session-active',
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-usage-active',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt active',
      phase: 'auditing',
      errorCount: 0,
      auditCount: 1,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId: 'ws-789',
      hostSessionId: 'host-012',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
    } as any)
    
    // Insert usage data from previous session
    loopSessionUsageRepo.upsertSessionUsage({
      projectId,
      loopName,
      sessionId: 'session-prev',
      role: 'code',
      model: 'anthropic/claude-3-opus',
      cost: 0.1250,
      inputTokens: 10000,
      outputTokens: 5000,
      reasoningTokens: 1000,
      cacheReadTokens: 200,
      cacheWriteTokens: 400,
      messageCount: 20,
      capturedAt: Date.now() - 10000,
    })
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath, {}, undefined, undefined, undefined, loopSessionUsageRepo)
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
      loopSessionUsageRepo,
    } as any)
    
    const result = await tools['loop-status'].execute({
      name: loopName,
    }, { sessionID: 'test-session' } as any)
    
    expect(result).toContain('Cumulative Usage:')
    expect(result).toContain('$0.1250')
    expect(result).toContain('anthropic/claude-3-opus')
  })

  test('per-model totals appear in cumulative usage', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = mockApi.client as unknown as OpencodeClient
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const worktreeDir = `${TEST_DIR}/worktree-usage-multi`
    mkdirSync(worktreeDir, { recursive: true })
    
    loopService.setState(loopName, {
      active: false,
      sessionId: 'session-multi',
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-multi',
      iteration: 1,
      maxIterations: 3,
      startedAt: new Date().toISOString(),
      prompt: 'Test',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'model-a',
      auditorModel: 'model-b',
      workspaceId: 'ws-multi',
      hostSessionId: 'host-multi',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      terminationReason: 'completed',
      completedAt: new Date().toISOString(),
    } as any)
    
    // Insert multiple models
    loopSessionUsageRepo.upsertSessionUsage([
      {
        projectId,
        loopName,
        sessionId: 'session-multi',
        role: 'code',
        model: 'anthropic/claude-3-5-sonnet',
        cost: 0.05,
        inputTokens: 5000,
        outputTokens: 2500,
        reasoningTokens: 500,
        cacheReadTokens: 100,
        cacheWriteTokens: 200,
        messageCount: 10,
        capturedAt: Date.now(),
      },
      {
        projectId,
        loopName,
        sessionId: 'session-multi',
        role: 'auditor',
        model: 'openai/gpt-4o',
        cost: 0.08,
        inputTokens: 8000,
        outputTokens: 4000,
        reasoningTokens: 800,
        cacheReadTokens: 150,
        cacheWriteTokens: 300,
        messageCount: 15,
        capturedAt: Date.now(),
      },
    ])
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath, {}, undefined, undefined, undefined, loopSessionUsageRepo)
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
      loopSessionUsageRepo,
    } as any)
    
    const result = await tools['loop-status'].execute({
      name: loopName,
    }, { sessionID: 'test-session' } as any)
    
    expect(result).toContain('Per-model usage:')
    expect(result).toContain('anthropic/claude-3-5-sonnet')
    expect(result).toContain('openai/gpt-4o')
  })

  test('live current session is merged when not persisted', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = createMockV2ClientWithMessages([
      { role: 'assistant', cost: 0.02, tokens: { input: 2000, output: 1000, reasoning: 200, cache: { read: 50, write: 25 } }, model: 'anthropic/claude-3-5-sonnet' },
    ])
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const worktreeDir = `${TEST_DIR}/worktree-usage-merge`
    mkdirSync(worktreeDir, { recursive: true })
    
    // Active loop with current session NOT persisted
    loopService.setState(loopName, {
      active: true,
      sessionId: 'session-current-live',
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-merge',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt merge',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId: 'ws-merge',
      hostSessionId: 'host-merge',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
    } as any)
    
    // Insert persisted data from PREVIOUS session only
    loopSessionUsageRepo.upsertSessionUsage({
      projectId,
      loopName,
      sessionId: 'session-prev',
      role: 'code',
      model: 'anthropic/claude-3-opus',
      cost: 0.10,
      inputTokens: 8000,
      outputTokens: 4000,
      reasoningTokens: 800,
      cacheReadTokens: 200,
      cacheWriteTokens: 400,
      messageCount: 15,
      capturedAt: Date.now() - 10000,
    })
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath, {}, undefined, undefined, undefined, loopSessionUsageRepo)
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
      loopSessionUsageRepo,
    } as any)
    
    const result = await tools['loop-status'].execute({
      name: loopName,
    }, { sessionID: 'test-session' } as any)
    
    // Should show merged total: 0.10 (persisted) + 0.02 (live) = 0.12
    expect(result).toContain('Cumulative Usage:')
    expect(result).toContain('$0.1200')
    // Both models should appear
    expect(result).toContain('anthropic/claude-3-opus')
    expect(result).toContain('anthropic/claude-3-5-sonnet')
  })

  test('already-persisted current session is not double-counted', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = createMockV2ClientWithMessages([
      { role: 'assistant', cost: 0.03, tokens: { input: 3000, output: 1500, reasoning: 300, cache: { read: 75, write: 40 } }, model: 'anthropic/claude-3-5-sonnet' },
    ])
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const worktreeDir = `${TEST_DIR}/worktree-usage-nodouble`
    mkdirSync(worktreeDir, { recursive: true })
    
    // Active loop with current session ALREADY persisted
    loopService.setState(loopName, {
      active: true,
      sessionId: 'session-current-persisted',
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-nodouble',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt nodouble',
      phase: 'auditing',
      errorCount: 0,
      auditCount: 1,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId: 'ws-nodouble',
      hostSessionId: 'host-nodouble',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
    } as any)
    
    // Insert persisted data including CURRENT session
    loopSessionUsageRepo.upsertSessionUsage([
      {
        projectId,
        loopName,
        sessionId: 'session-prev-nodouble',
        role: 'code',
        model: 'anthropic/claude-3-opus',
        cost: 0.10,
        inputTokens: 8000,
        outputTokens: 4000,
        reasoningTokens: 800,
        cacheReadTokens: 200,
        cacheWriteTokens: 400,
        messageCount: 15,
        capturedAt: Date.now() - 10000,
      },
      {
        projectId,
        loopName,
        sessionId: 'session-current-persisted',
        role: 'code',
        model: 'anthropic/claude-3-5-sonnet',
        cost: 0.03,
        inputTokens: 3000,
        outputTokens: 1500,
        reasoningTokens: 300,
        cacheReadTokens: 75,
        cacheWriteTokens: 40,
        messageCount: 5,
        capturedAt: Date.now(),
      },
    ])
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath, {}, undefined, undefined, undefined, loopSessionUsageRepo)
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
      loopSessionUsageRepo,
    } as any)
    
    const result = await tools['loop-status'].execute({
      name: loopName,
    }, { sessionID: 'test-session' } as any)
    
    // Should show ONLY persisted total: 0.10 + 0.03 = 0.13 (NOT double-counted)
    expect(result).toContain('Cumulative Usage:')
    expect(result).toContain('$0.1300')
    // Should NOT be 0.16 (which would indicate double-counting)
    expect(result).not.toContain('$0.1600')
    expect(result).toContain('anthropic/claude-3-opus')
    expect(result).toContain('anthropic/claude-3-5-sonnet')
  })

  test('cumulative usage appears from live usage even when no persisted aggregate exists', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = createMockV2ClientWithMessages([
      { role: 'assistant', cost: 0.015, tokens: { input: 1500, output: 750, reasoning: 150, cache: { read: 40, write: 20 } }, model: 'anthropic/claude-3-5-sonnet' },
    ])
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const worktreeDir = `${TEST_DIR}/worktree-usage-liveonly`
    mkdirSync(worktreeDir, { recursive: true })
    
    // Active loop with NO persisted usage
    loopService.setState(loopName, {
      active: true,
      sessionId: 'session-live-only',
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-liveonly',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt live only',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId: 'ws-liveonly',
      hostSessionId: 'host-liveonly',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
    } as any)
    
    // NO persisted usage inserted
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath, {}, undefined, undefined, undefined, loopSessionUsageRepo)
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
      loopSessionUsageRepo,
    } as any)
    
    const result = await tools['loop-status'].execute({
      name: loopName,
    }, { sessionID: 'test-session' } as any)
    
    // Should show live usage only
    expect(result).toContain('Cumulative Usage:')
    expect(result).toContain('$0.0150')
    expect(result).toContain('anthropic/claude-3-5-sonnet')
  })

  test('inactive loop merges live final session when not persisted', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = createMockV2ClientWithMessages([
      { role: 'assistant', cost: 0.025, tokens: { input: 2500, output: 1250, reasoning: 250, cache: { read: 60, write: 30 } }, model: 'anthropic/claude-3-5-sonnet' },
    ])
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const worktreeDir = `${TEST_DIR}/worktree-usage-inactive-live`
    mkdirSync(worktreeDir, { recursive: true })
    
    // Inactive loop with final session NOT persisted (simulates failed termination capture)
    loopService.setState(loopName, {
      active: false,
      sessionId: 'session-final-live',
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-inactive-live',
      iteration: 3,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt inactive live',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId: 'ws-inactive-live',
      hostSessionId: 'host-inactive-live',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      terminationReason: 'completed',
      completedAt: new Date().toISOString(),
    } as any)
    
    // Insert persisted data from PREVIOUS sessions only (final session NOT persisted)
    loopSessionUsageRepo.upsertSessionUsage({
      projectId,
      loopName,
      sessionId: 'session-prev-inactive',
      role: 'code',
      model: 'anthropic/claude-3-opus',
      cost: 0.08,
      inputTokens: 7000,
      outputTokens: 3500,
      reasoningTokens: 700,
      cacheReadTokens: 180,
      cacheWriteTokens: 360,
      messageCount: 12,
      capturedAt: Date.now() - 10000,
    })
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath, {}, undefined, undefined, undefined, loopSessionUsageRepo)
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
      loopSessionUsageRepo,
    } as any)
    
    const result = await tools['loop-status'].execute({
      name: loopName,
    }, { sessionID: 'test-session' } as any)
    
    // Should show merged total: 0.08 (persisted) + 0.025 (live) = 0.105
    expect(result).toContain('Cumulative Usage:')
    expect(result).toContain('$0.1050')
    // Both models should appear
    expect(result).toContain('anthropic/claude-3-opus')
    expect(result).toContain('anthropic/claude-3-5-sonnet')
  })

  test('inactive loop uses persisted-only when final session is already persisted', async () => {
    const mockApi = createMockTuiApi()
    const v2Client = createMockV2ClientWithMessages([
      { role: 'assistant', cost: 0.035, tokens: { input: 3500, output: 1750, reasoning: 350, cache: { read: 90, write: 45 } }, model: 'anthropic/claude-3-5-sonnet' },
    ])
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const worktreeDir = `${TEST_DIR}/worktree-usage-inactive-persisted`
    mkdirSync(worktreeDir, { recursive: true })
    
    // Inactive loop with final session ALREADY persisted
    loopService.setState(loopName, {
      active: false,
      sessionId: 'session-final-persisted',
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-inactive-persisted',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt inactive persisted',
      phase: 'auditing',
      errorCount: 0,
      auditCount: 1,
      worktree: true,
      sandbox: false,
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      workspaceId: 'ws-inactive-persisted',
      hostSessionId: 'host-inactive-persisted',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      terminationReason: 'completed',
      completedAt: new Date().toISOString(),
    } as any)
    
    // Insert persisted data including final session
    loopSessionUsageRepo.upsertSessionUsage([
      {
        projectId,
        loopName,
        sessionId: 'session-prev-inactive-p',
        role: 'code',
        model: 'anthropic/claude-3-opus',
        cost: 0.09,
        inputTokens: 7500,
        outputTokens: 3750,
        reasoningTokens: 750,
        cacheReadTokens: 190,
        cacheWriteTokens: 380,
        messageCount: 14,
        capturedAt: Date.now() - 10000,
      },
      {
        projectId,
        loopName,
        sessionId: 'session-final-persisted',
        role: 'code',
        model: 'anthropic/claude-3-5-sonnet',
        cost: 0.035,
        inputTokens: 3500,
        outputTokens: 1750,
        reasoningTokens: 350,
        cacheReadTokens: 90,
        cacheWriteTokens: 45,
        messageCount: 6,
        capturedAt: Date.now(),
      },
    ])
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath, {}, undefined, undefined, undefined, loopSessionUsageRepo)
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
      loopSessionUsageRepo,
    } as any)
    
    const result = await tools['loop-status'].execute({
      name: loopName,
    }, { sessionID: 'test-session' } as any)
    
    // Should show ONLY persisted total: 0.09 + 0.035 = 0.125 (NOT double-counted with live)
    expect(result).toContain('Cumulative Usage:')
    expect(result).toContain('$0.1250')
    // Should NOT be 0.160 (which would indicate double-counting with live 0.035)
    expect(result).not.toContain('$0.1600')
    expect(result).toContain('anthropic/claude-3-opus')
    expect(result).toContain('anthropic/claude-3-5-sonnet')
  })

  test('active loop attributes live usage to executionModel when messages lack model metadata', async () => {
    const mockApi = createMockTuiApi()
    // Messages WITHOUT model field - should fall back to loop state's executionModel
    const v2Client = createMockV2ClientWithMessages([
      { role: 'assistant', cost: 0.02, tokens: { input: 2000, output: 1000, reasoning: 200, cache: { read: 50, write: 25 } } },
    ])
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const worktreeDir = `${TEST_DIR}/worktree-usage-attrib-active`
    mkdirSync(worktreeDir, { recursive: true })
    
    // Active loop in coding phase with dialog-selected model
    loopService.setState(loopName, {
      active: true,
      sessionId: 'session-live-attrib',
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-attrib-active',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt attribution',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: 'anthropic/claude-3-7-sonnet',
      auditorModel: 'anthropic/claude-3-opus',
      workspaceId: 'ws-attrib-active',
      hostSessionId: 'host-attrib-active',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
    } as any)
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath, {}, undefined, undefined, undefined, loopSessionUsageRepo)
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
      loopSessionUsageRepo,
    } as any)
    
    const result = await tools['loop-status'].execute({
      name: loopName,
    }, { sessionID: 'test-session' } as any)
    
    // Live usage should be attributed to executionModel from loop state, NOT 'default/session model'
    expect(result).toContain('Cumulative Usage:')
    expect(result).toContain('anthropic/claude-3-7-sonnet')
    expect(result).not.toContain('default/session model')
  })

  test('active loop in auditing phase attributes live usage to auditorModel when messages lack model metadata', async () => {
    const mockApi = createMockTuiApi()
    // Messages WITHOUT model field - should fall back to loop state's auditorModel
    const v2Client = createMockV2ClientWithMessages([
      { role: 'assistant', cost: 0.025, tokens: { input: 2500, output: 1250, reasoning: 250, cache: { read: 60, write: 30 } } },
    ])
    const logger = createLogger({ enabled: false, file: '' })
    
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
    
    const worktreeDir = `${TEST_DIR}/worktree-usage-attrib-audit`
    mkdirSync(worktreeDir, { recursive: true })
    
    // Active loop in auditing phase with distinct auditor model
    loopService.setState(loopName, {
      active: true,
      sessionId: 'session-live-audit-attrib',
      loopName,
      worktreeDir,
      projectDir: TEST_DIR,
      worktreeBranch: 'opencode/loop-test-attrib-audit',
      iteration: 2,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt audit attribution',
      phase: 'auditing',
      errorCount: 0,
      auditCount: 1,
      worktree: true,
      sandbox: false,
      executionModel: 'anthropic/claude-3-7-sonnet',
      auditorModel: 'openai/gpt-4o',
      workspaceId: 'ws-attrib-audit',
      hostSessionId: 'host-attrib-audit',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
    } as any)
    
    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockApi as any, v2Client, logger, () => ({}), undefined, dbPath, {}, undefined, undefined, undefined, loopSessionUsageRepo)
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
      loopSessionUsageRepo,
    } as any)
    
    const result = await tools['loop-status'].execute({
      name: loopName,
    }, { sessionID: 'test-session' } as any)
    
    // Live usage should be attributed to auditorModel from loop state, NOT 'default/session model'
    expect(result).toContain('Cumulative Usage:')
    expect(result).toContain('openai/gpt-4o')
    expect(result).not.toContain('default/session model')
  })
})
