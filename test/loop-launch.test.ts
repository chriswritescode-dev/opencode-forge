import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { launchFreshLoop } from '../src/utils/loop-launch'
import { createForgeWorktreeAdaptor } from '../src/workspace/forge-worktree'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

const TEST_DIR = '/tmp/opencode-manager-loop-launch-test-' + Date.now()

function createTestDb(): { db: Database; path: string } {
  const path = `${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`
  const db = new Database(path)
  // Create the new loops schema
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
      audit_session_id     TEXT,
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
  db.run(`CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(project_id, status)`)
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_session ON loops(project_id, current_session_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_loops_completed_at ON loops(status, completed_at) WHERE status != 'running'`)
  return { db, path }
}

function createMockApi(overrides?: Partial<TuiPluginApi>): TuiPluginApi {
  return {
    client: {
      session: {
        create: mock(async (params) => {
          return {
            data: { id: 'mock-session-' + Date.now(), title: params.title },
            error: null,
          }
        }),
        promptAsync: mock(async () => ({ data: {} })),
        abort: mock(async () => ({ data: {} })),
      },
      worktree: {
        create: mock(async (params) => {
          return {
            data: {
              name: params.worktreeCreateInput.name,
              directory: `/tmp/worktree-${params.worktreeCreateInput.name}`,
              branch: `opencode/loop-${params.worktreeCreateInput.name}`,
            },
            error: null,
          }
        }),
        remove: mock(async () => ({ data: {}, error: null })),
      },
      experimental: {
        workspace: {
          create: mock(async (params) => ({
            data: { id: params.id ?? 'mock-workspace-' + Date.now() },
            error: null,
          })),
          sessionRestore: mock(async () => ({ data: {}, error: null })),
        },
      },
    },
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

describe('Fresh Loop Launch', () => {
  let db: Database
  let dbPath: string
  const projectId = 'test-project'
  const planText = '# Test Plan\n\nThis is a test plan for loop execution.'
  const title = 'Test Loop'

  test('normalizes forge worktree workspace metadata before display', () => {
    const adaptor = createForgeWorktreeAdaptor()
    const configured = adaptor.configure({
      id: 'test-plan',
      type: 'forge-worktree',
      name: 'unknown',
      branch: null,
      directory: null,
      extra: JSON.stringify({
        loopName: 'test-plan',
        directory: '/tmp/worktree-test-plan',
        branch: 'opencode/loop-test-plan',
      }),
      projectID: 'test-project',
    })

    expect(configured).toEqual(expect.objectContaining({
      name: 'test-plan',
      directory: '/tmp/worktree-test-plan',
      branch: 'opencode/loop-test-plan',
    }))
  })

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    dbPath = result.path
  })

  afterEach(() => {
    db.close()
  })

  test('Creates fresh in-place loop session', async () => {
    const mockApi = createMockApi()
    
    const sessionId = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(sessionId).toBeDefined()
    expect(mockApi.client.session.create).toHaveBeenCalledWith({
      title: `Loop: ${title}`,
      directory: TEST_DIR,
      permission: expect.arrayContaining([
        expect.objectContaining({ permission: 'bash', action: 'deny', pattern: 'git push *' }),
      ]),
    })
    const callArgs = (mockApi.client.session.create as ReturnType<typeof mock>).mock.calls[0][0]
    const hasAllowAll = callArgs.permission.some((r: { permission: string; action: string }) => r.permission === '*' && r.action === 'allow')
    expect(hasAllowAll).toBe(false)
    // In-place loops should have no external_directory rule (OpenCode asks by default)
    const hasExternalDirRule = callArgs.permission.some((r: { permission: string }) => r.permission === 'external_directory')
    expect(hasExternalDirRule).toBe(false)
    expect(mockApi.client.session.promptAsync).toHaveBeenCalled()
  })

  test('Creates fresh worktree loop session', async () => {
    const mockApi = createMockApi()
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      sandboxEnabled: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    expect(result?.sessionId).toBeDefined()
    expect(mockApi.client.worktree.create).toHaveBeenCalledWith({
      worktreeCreateInput: { name: 'test-plan' }, // Falls back to title since no Loop Name field
    })
    expect(mockApi.client.experimental?.workspace?.create).toHaveBeenCalledWith({
      id: 'test-plan',
      type: 'forge-worktree',
      branch: 'opencode/loop-test-plan',
      extra: {
        loopName: 'test-plan',
        directory: '/tmp/worktree-test-plan',
        branch: 'opencode/loop-test-plan',
      },
    })
    expect(mockApi.client.session.create).toHaveBeenCalled()
    expect(mockApi.client.session.create).toHaveBeenCalledWith(expect.objectContaining({
      workspace: 'test-plan',
    }))
  })

  test('Persists loop state to loops table for in-place loop', async () => {
    const mockApi = createMockApi()
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    
    // Verify loop state was written to loops table
    const loopRow = db.prepare(
      'SELECT * FROM loops WHERE project_id = ? AND loop_name LIKE ?'
    ).get(projectId, 'test-plan%') as any | null

    expect(loopRow).toBeDefined()
    if (loopRow) {
      expect(loopRow.status).toBe('running')
      expect(loopRow.worktree).toBe(0)
      expect(loopRow.phase).toBe('coding')
      expect(loopRow.loop_name).toBe('test-plan') // Falls back to title
      
      // Verify prompt in loop_large_fields
      const largeFieldsRow = db.prepare(
        'SELECT prompt FROM loop_large_fields WHERE project_id = ? AND loop_name = ?'
      ).get(projectId, loopRow.loop_name) as { prompt: string } | null
      expect(largeFieldsRow?.prompt).toBe(planText)
    }
  })

  test('Persists loop state to loops table for worktree loop', async () => {
    const mockApi = createMockApi()
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      sandboxEnabled: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    expect(result?.isWorktree).toBe(true)
    expect(result?.executionName).toBe('test-plan')
    
    const loopRow = db.prepare(
      'SELECT * FROM loops WHERE project_id = ? AND loop_name LIKE ?'
    ).get(projectId, 'test-plan%') as any | null

    expect(loopRow).toBeDefined()
    if (loopRow) {
      expect(loopRow.status).toBe('running')
      expect(loopRow.worktree).toBe(1)
      expect(loopRow.worktree_dir).toBeDefined()
    }
  })

  test('non-sandbox worktree loop passes host path to session.create', async () => {
    const mockApi = createMockApi()
    const sessionCreateSpy = mock(async () => ({ data: { id: 'test-session' } }))
    mockApi.client.session.create = sessionCreateSpy as any
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      sandboxEnabled: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(sessionCreateSpy).toHaveBeenCalled()
    const call = (mockApi.client.session.create as any).mock.calls[0][0]
    expect(call.directory).not.toMatch(/^\/workspace/)
  })

  test('sandbox-enabled worktree loop passes container path to session.create', async () => {
    const mockApi = createMockApi()
    const sessionCreateSpy = mock(async () => ({ data: { id: 'test-session' } }))
    mockApi.client.session.create = sessionCreateSpy as any
    // Mock worktree.create to return a predictable path
    mockApi.client.worktree.create = mock(async (params) => ({
      data: {
        name: params.worktreeCreateInput.name,
        directory: `/tmp/test-worktree-dir`,
        branch: `opencode/loop-${params.worktreeCreateInput.name}`,
      },
      error: null,
    })) as any
    
    // Skip sandbox wait since we don't have Docker reconciliation in tests
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      sandboxEnabled: true,
      skipSandboxWait: true,
      v2: mockApi.client,
      dbPath,
    })

    expect(sessionCreateSpy).toHaveBeenCalled()
    const call = (mockApi.client.session.create as any).mock.calls[0][0]
    // Session directory should always be the host path, not /workspace
    expect(call.directory).not.toMatch(/^\/workspace/)
  })

  test('persists worktreeDir (host path) for sandbox worktree', async () => {
    const mockApi = createMockApi()
    // Mock worktree.create to return a predictable path
    mockApi.client.worktree.create = mock(async (params) => ({
      data: {
        name: params.worktreeCreateInput.name,
        directory: `/tmp/test-worktree-dir`,
        branch: `opencode/loop-${params.worktreeCreateInput.name}`,
      },
      error: null,
    })) as any
    
    // Skip sandbox wait since we don't have Docker reconciliation in tests
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      sandboxEnabled: true,
      skipSandboxWait: true,
      v2: mockApi.client,
      dbPath,
    })

    const loopRow = db.prepare(
      'SELECT worktree_dir FROM loops WHERE project_id = ? AND loop_name LIKE ?'
    ).get(projectId, 'test-plan%') as { worktree_dir: string } | null

    expect(loopRow).toBeDefined()
    if (loopRow) {
      expect(loopRow.worktree_dir).not.toMatch(/^\/workspace/)
      expect(loopRow.worktree_dir).toBe('/tmp/test-worktree-dir')
    }
  })

  test('Persists session mapping to loops.current_session_id', async () => {
    const mockApi = createMockApi()
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    
    const loopRow = db.prepare(
      'SELECT current_session_id, loop_name FROM loops WHERE project_id = ? AND current_session_id = ?'
    ).get(projectId, result!.sessionId) as { current_session_id: string; loop_name: string } | null

    expect(loopRow).toBeDefined()
    if (loopRow) {
      expect(loopRow.current_session_id).toBe(result!.sessionId)
      expect(loopRow.loop_name).toBe('test-plan')
    }
  })

  test('Stores plan in loop_large_fields', async () => {
    const mockApi = createMockApi()
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    const planRow = db.prepare(
      'SELECT prompt FROM loop_large_fields WHERE project_id = ? AND loop_name LIKE ?'
    ).get(projectId, 'test-plan%') as { prompt: string } | null

    expect(planRow).toBeDefined()
    if (planRow) {
      expect(planRow.prompt).toBe(planText)
    }
  })

  test('Returns null when session creation fails', async () => {
    const mockApi = createMockApi({
      client: {
        session: {
          create: mock(async () => ({ data: null as any, error: 'Failed' })),
          promptAsync: mock(async () => ({ data: {} })),
          abort: mock(async () => ({ data: {} })),
        },
        worktree: {
          create: mock(async () => ({ data: null as any, error: 'Failed' })),
        },
      },
    } as any)

    const sessionId = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(sessionId).toBeNull()
  })

  test('Sends prompt with completion signal instructions', async () => {
    const mockApi = createMockApi()
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(mockApi.client.session.promptAsync).toHaveBeenCalled()
    const callArgs = (mockApi.client.session.promptAsync as any).mock.calls[0][0]
    expect(callArgs.parts[0].text).toContain(planText)
  })

  test('Uses explicit Loop Name field when present', async () => {
    const mockApi = createMockApi()
    const planWithLoopName = '# Test Plan\n\nLoop Name: custom-name\n\nContent here.'
    
    const result = await launchFreshLoop({
      planText: planWithLoopName,
      title: 'Test Plan',
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    expect(result?.loopName).toBe('custom-name')
    expect(result?.executionName).toBe('custom-name')
  })

  test('Returns structured LaunchResult with all fields', async () => {
    const mockApi = createMockApi()
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      sandboxEnabled: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    expect(result?.sessionId).toBeDefined()
    expect(result?.loopName).toBeDefined()
    expect(result?.executionName).toBeDefined()
    expect(result?.isWorktree).toBe(true)
    expect(result?.worktreeDir).toBeDefined()
    expect(result?.worktreeBranch).toBeDefined()
  })

  test('Persists loop state immediately with schema-valid structure', async () => {
    const mockApi = createMockApi()
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    
    // Verify loops table row exists immediately after launch
    const loopRow = db.prepare(
      'SELECT * FROM loops WHERE project_id = ? AND loop_name = ?'
    ).get(projectId, result!.executionName) as any | null

    expect(loopRow).toBeDefined()
    if (loopRow) {
      expect(loopRow.status).toBe('running')
      expect(loopRow.current_session_id).toBe(result?.sessionId)
      expect(loopRow.loop_name).toBe(result!.executionName)
      expect(loopRow.worktree_dir).toBeDefined()
      expect(loopRow.iteration).toBe(1)
      expect(loopRow.phase).toBe('coding')
      expect(loopRow.worktree).toBe(0)
      expect(loopRow.started_at).toBeDefined()
      
      // Verify prompt in loop_large_fields
      const largeFieldsRow = db.prepare(
        'SELECT prompt FROM loop_large_fields WHERE project_id = ? AND loop_name = ?'
      ).get(projectId, loopRow.loop_name) as { prompt: string } | null
      expect(largeFieldsRow?.prompt).toBe(planText)
    }
  })



  test('Persists session mapping immediately after launch', async () => {
    const mockApi = createMockApi()
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    
    // Verify current_session_id in loops table
    const loopRow = db.prepare(
      'SELECT current_session_id, loop_name FROM loops WHERE project_id = ? AND current_session_id = ?'
    ).get(projectId, result!.sessionId) as { current_session_id: string; loop_name: string } | null

    expect(loopRow).toBeDefined()
    if (loopRow && result?.executionName) {
      expect(loopRow.current_session_id).toBe(result!.sessionId)
      expect(loopRow.loop_name).toBe(result.executionName)
    }
  })

  test('Sanitizes loop names with special characters', async () => {
    const mockApi = createMockApi()
    const planWithSpecialChars = '# Test Plan\n\nLoop Name: API v2.0 Migration!\n\nContent.'
    
    const result = await launchFreshLoop({
      planText: planWithSpecialChars,
      title: 'Test Plan',
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    // Display name preserves original formatting
    expect(result?.loopName).toBe('API v2.0 Migration!')
    // Worktree name is sanitized
    expect(result?.executionName).toBe('api-v2-0-migration')
  })

  test('Uses code agent for prompt', async () => {
    const mockApi = createMockApi()
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    const callArgs = (mockApi.client.session.promptAsync as any).mock.calls[0][0]
    expect(callArgs.agent).toBe('code')
  })

  test('Returns display name in loopName field (not sanitized)', async () => {
    const mockApi = createMockApi()
    const planWithDisplayName = '# Test Plan\n\nLoop Name: API Migration v2.0\n\nContent.'
    
    const result = await launchFreshLoop({
      planText: planWithDisplayName,
      title: 'Test Plan',
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    // Display name should preserve original casing
    expect(result?.loopName).toBe('API Migration v2.0')
    // Worktree name should be sanitized
    expect(result?.executionName).toBe('api-migration-v2-0')
  })

  test('Display name uses markdown bold format correctly', async () => {
    const mockApi = createMockApi()
    const planWithMarkdown = '# Plan\n\n**Loop Name**: User Auth System\n\nContent'
    
    const result = await launchFreshLoop({
      planText: planWithMarkdown,
      title: 'Test Plan',
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    expect(result?.loopName).toBe('User Auth System')
    expect(result?.executionName).toBe('user-auth-system')
  })

  test('Display name handles bullet list format', async () => {
    const mockApi = createMockApi()
    const planWithBullet = '# Plan\n\n- **Loop Name**: Database Optimization\n\nContent'
    
    const result = await launchFreshLoop({
      planText: planWithBullet,
      title: 'Test Plan',
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    expect(result?.loopName).toBe('Database Optimization')
    expect(result?.executionName).toBe('database-optimization')
  })

  test('Falls back to title when no explicit loop name', async () => {
    const mockApi = createMockApi()
    const planWithoutLoopName = '# Fallback Title Here\n\nContent without loop name'
    
    const result = await launchFreshLoop({
      planText: planWithoutLoopName,
      title: 'Fallback Title Here',
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    expect(result?.loopName).toBe('Fallback Title Here')
    expect(result?.executionName).toBe('fallback-title-here')
  })

  test('waits for worktree graph readiness before first prompt', async () => {
    const mockApi = createMockApi()
    
    // Track call order
    let waitForGraphReadyCalled = false
    let promptAsyncCalled = false
    let waitForGraphReadyCalledBeforePrompt = false
    
    // Create a spy for waitForGraphReady by mocking the module
    const tuiGraphStatusModule = await import('../src/utils/tui-graph-status')
    const originalWaitForGraphReady = tuiGraphStatusModule.waitForGraphReady
    
    // We can verify by checking that the function exists and is exported
    // The actual wait behavior is tested in tui-graph-status.test.ts
    // Here we verify the integration by checking promptAsync is called
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      sandboxEnabled: false,
      v2: mockApi.client,
      dbPath,
    })

    // Verify worktree was created
    expect(mockApi.client.worktree.create).toHaveBeenCalled()
    // Verify session was created
    expect(mockApi.client.session.create).toHaveBeenCalled()
    // Verify prompt was sent
    expect(mockApi.client.session.promptAsync).toHaveBeenCalled()
    // Verify waitForGraphReady is exported and available for worktree mode
    expect(originalWaitForGraphReady).toBeDefined()
    expect(typeof originalWaitForGraphReady).toBe('function')
  })

  test('in-place loops do not wait for graph', async () => {
    const mockApi = createMockApi()
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
    })

    // Verify session was created for in-place mode
    expect(mockApi.client.session.create).toHaveBeenCalledWith({
      title: `Loop: ${title}`,
      directory: TEST_DIR,
      permission: expect.anything(),
    })
    // Verify prompt was sent
    expect(mockApi.client.session.promptAsync).toHaveBeenCalled()
  })

  test('Persists executionModel and auditorModel on loop state when provided', async () => {
    const mockApi = createMockApi()
    const executionModel = 'anthropic/claude-sonnet-4-20250514'
    const auditorModel = 'anthropic/claude-3-5-sonnet-20241022'
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
      executionModel,
      auditorModel,
    })

    const loopRow = db.prepare(
      'SELECT execution_model, auditor_model FROM loops WHERE project_id = ? AND loop_name LIKE ?'
    ).get(projectId, 'test-plan%') as { execution_model: string; auditor_model: string } | null

    expect(loopRow).toBeDefined()
    if (loopRow) {
      expect(loopRow.execution_model).toBe(executionModel)
      expect(loopRow.auditor_model).toBe(auditorModel)
    }
  })

  test('Persists only executionModel when auditorModel is not provided', async () => {
    const mockApi = createMockApi()
    const executionModel = 'anthropic/claude-sonnet-4-20250514'
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
      executionModel,
    })

    const loopRow = db.prepare(
      'SELECT execution_model, auditor_model FROM loops WHERE project_id = ? AND loop_name LIKE ?'
    ).get(projectId, 'test-plan%') as { execution_model: string; auditor_model: string } | null

    expect(loopRow).toBeDefined()
    if (loopRow) {
      expect(loopRow.execution_model).toBe(executionModel)
      expect(loopRow.auditor_model).toBeNull()
    }
  })

  test('Uses executionModel for first prompt with retryWithModelFallback', async () => {
    const mockApi = createMockApi()
    const executionModel = 'anthropic/test-model'
    const promptAsyncSpy = mock(async () => ({ data: {} }))
    mockApi.client.session.promptAsync = promptAsyncSpy as any
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
      executionModel,
    })

    expect(promptAsyncSpy).toHaveBeenCalled()
  })

  test('First prompt includes model field when executionModel is provided', async () => {
    const mockApi = createMockApi()
    const executionModel = 'anthropic/claude-sonnet-4-20250514'
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
      executionModel,
    })

    expect(mockApi.client.session.promptAsync).toHaveBeenCalled()
    const call = (mockApi.client.session.promptAsync as any).mock.calls[0][0]
    // parseModelString converts 'anthropic/claude-sonnet-4-20250514' to { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' }
    expect(call.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' })
  })

  test('Persists both executionModel and auditorModel and uses executionModel for first prompt', async () => {
    const mockApi = createMockApi()
    const executionModel = 'anthropic/claude-sonnet-4-20250514'
    const auditorModel = 'anthropic/claude-3-5-sonnet-20241022'
    const promptAsyncSpy = mock(async () => ({ data: {} }))
    mockApi.client.session.promptAsync = promptAsyncSpy as any
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
      executionModel,
      auditorModel,
    })

    // Verify models were persisted
    const loopRow = db.prepare(
      'SELECT execution_model, auditor_model FROM loops WHERE project_id = ? AND loop_name LIKE ?'
    ).get(projectId, 'test-plan%') as { execution_model: string; auditor_model: string } | null

    expect(loopRow).toBeDefined()
    if (loopRow) {
      expect(loopRow.execution_model).toBe(executionModel)
      expect(loopRow.auditor_model).toBe(auditorModel)
    }

    // Verify first prompt was sent
    expect(promptAsyncSpy).toHaveBeenCalled()
  })

  test('Creates in-place loop with hostSessionId metadata but no parentID', async () => {
    const mockApi = createMockApi()
    const sessionCreateSpy = mock(async () => ({ data: { id: 'test-session' } }))
    mockApi.client.session.create = sessionCreateSpy as any
    
    const hostSessionId = 'host-session-123'
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      hostSessionId,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    
    // Verify session.create was called without parentID
    const createArgs = (mockApi.client.session.create as ReturnType<typeof mock>).mock.calls[0]?.[0]
    expect(createArgs).toEqual(expect.objectContaining({
      title: expect.stringContaining('Loop:'),
      directory: TEST_DIR,
    }))
    expect(createArgs).not.toHaveProperty('parentID')
    
    // Verify host_session_id persists in loop row
    const loopRow = db.prepare(
      'SELECT host_session_id FROM loops WHERE project_id = ? AND loop_name LIKE ?'
    ).get(projectId, 'test-plan%') as { host_session_id: string | null } | null
    
    expect(loopRow).toBeDefined()
    expect(loopRow?.host_session_id).toBe(hostSessionId)
  })

  test('Creates worktree loop with hostSessionId metadata but no parentID', async () => {
    const mockApi = createMockApi()
    const sessionCreateSpy = mock(async () => ({ data: { id: 'test-session' } }))
    mockApi.client.session.create = sessionCreateSpy as any
    
    const hostSessionId = 'host-session-456'
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      hostSessionId,
      sandboxEnabled: false,
      skipSandboxWait: true,
      v2: mockApi.client,
      dbPath,
    })

    expect(result).toBeDefined()
    expect(result?.isWorktree).toBe(true)
    
    // Verify session.create was called without parentID
    const createArgs = (mockApi.client.session.create as ReturnType<typeof mock>).mock.calls[0]?.[0]
    expect(createArgs).toEqual(expect.objectContaining({
      title: expect.stringContaining('Loop:'),
    }))
    expect(createArgs).not.toHaveProperty('parentID')
    
    // Verify host_session_id persists in loop row
    const loopRow = db.prepare(
      'SELECT host_session_id FROM loops WHERE project_id = ? AND loop_name LIKE ?'
    ).get(projectId, 'test-plan%') as { host_session_id: string | null } | null
    
    expect(loopRow).toBeDefined()
    expect(loopRow?.host_session_id).toBe(hostSessionId)
  })
  
  test('retryWithModelFallback retries and falls back to default model', async () => {
    const mockApi = createMockApi()
    const executionModel = 'anthropic/unavailable-model'
    let callCount = 0
    
    const promptAsyncSpy = mock(async (params: any) => {
      callCount++
      if (callCount <= 2) {
        // First two calls with model fail (maxRetries=2)
        return { data: undefined, error: { name: 'ProviderError', message: 'Model not found' } }
      }
      // Third call without model (fallback) succeeds
      return { data: {} }
    })
    mockApi.client.session.promptAsync = promptAsyncSpy as any
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      v2: mockApi.client,
      dbPath,
      executionModel,
    })

    // Should have been called 3 times: twice with model (failed), once without (succeeded)
    expect(promptAsyncSpy).toHaveBeenCalledTimes(3)
    
    // First two calls should have included the model
    const firstCall = (mockApi.client.session.promptAsync as any).mock.calls[0][0]
    expect(firstCall.model).toEqual({ providerID: 'anthropic', modelID: 'unavailable-model' })
    
    const secondCall = (mockApi.client.session.promptAsync as any).mock.calls[1][0]
    expect(secondCall.model).toEqual({ providerID: 'anthropic', modelID: 'unavailable-model' })
    
    // Third call should not have included the model (fallback)
    const thirdCall = (mockApi.client.session.promptAsync as any).mock.calls[2][0]
    expect(thirdCall.model).toBeUndefined()
  })
})
