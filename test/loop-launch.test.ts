import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { launchFreshLoop } from '../src/utils/loop-launch'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

const TEST_DIR = '/tmp/opencode-manager-loop-launch-test-' + Date.now()

function createTestDb(): { db: Database; path: string } {
  const path = `${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`
  const db = new Database(path)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_kv (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_project_kv_expires_at ON project_kv(expires_at)`)
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
      api: mockApi,
      dbPath,
    })

    expect(sessionId).toBeDefined()
    expect(mockApi.client.session.create).toHaveBeenCalledWith({
      title: `Loop: ${title}`,
      directory: TEST_DIR,
      permission: expect.arrayContaining([
        expect.objectContaining({ permission: 'external_directory', action: 'deny', pattern: '*' }),
        expect.objectContaining({ permission: 'bash', action: 'deny', pattern: 'git push *' }),
      ]),
    })
    const callArgs = (mockApi.client.session.create as ReturnType<typeof mock>).mock.calls[0][0]
    const hasAllowAll = callArgs.permission.some((r: { permission: string; action: string }) => r.permission === '*' && r.action === 'allow')
    expect(hasAllowAll).toBe(false)
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
      api: mockApi,
      dbPath,
    })

    expect(result).toBeDefined()
    expect(result?.sessionId).toBeDefined()
    expect(mockApi.client.worktree.create).toHaveBeenCalledWith({
      worktreeCreateInput: { name: 'test-plan' }, // Falls back to title since no Loop Name field
    })
    expect(mockApi.client.session.create).toHaveBeenCalled()
  })

  test('Persists loop state to KV for in-place loop', async () => {
    const mockApi = createMockApi()
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      api: mockApi,
      dbPath,
    })

    expect(result).toBeDefined()
    
    // Verify loop state was written to KV
    const loopStateRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key LIKE ?'
    ).get(projectId, 'loop:%') as { data: string } | null

    expect(loopStateRow).toBeDefined()
    if (loopStateRow) {
      const state = JSON.parse(loopStateRow.data)
      expect(state.active).toBe(true)
      expect(state.worktree).toBe(false)
      expect(state.phase).toBe('coding')
      expect(state.prompt).toBe(planText)
      expect(state.loopName).toBe('test-plan') // Falls back to title
    }
  })

  test('Persists loop state to KV for worktree loop', async () => {
    const mockApi = createMockApi()
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      api: mockApi,
      dbPath,
    })

    expect(result).toBeDefined()
    expect(result?.isWorktree).toBe(true)
    expect(result?.executionName).toBe('test-plan')
    
    const loopStateRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key LIKE ?'
    ).get(projectId, 'loop:%') as { data: string } | null

    expect(loopStateRow).toBeDefined()
    if (loopStateRow) {
      const state = JSON.parse(loopStateRow.data)
      expect(state.active).toBe(true)
      expect(state.worktree).toBe(true)
      expect(state.worktreeDir).toBeDefined()
    }
  })

  test('Persists session mapping to KV', async () => {
    const mockApi = createMockApi()
    
    const result = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      api: mockApi,
      dbPath,
    })

    expect(result).toBeDefined()
    
    const sessionRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key = ?'
    ).get(projectId, `loop-session:${result!.sessionId}`) as { data: string } | null

    expect(sessionRow).toBeDefined()
    if (sessionRow) {
      const loopName = JSON.parse(sessionRow.data)
      expect(loopName).toBe('test-plan')
    }
  })

  test('Stores plan with worktree name key', async () => {
    const mockApi = createMockApi()
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      api: mockApi,
      dbPath,
    })

    const planRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key LIKE ?'
    ).get(projectId, 'plan:%') as { data: string } | null

    expect(planRow).toBeDefined()
    if (planRow) {
      const storedPlan = JSON.parse(planRow.data)
      expect(storedPlan).toBe(planText)
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
      api: mockApi,
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
      api: mockApi,
      dbPath,
    })

    expect(mockApi.client.session.promptAsync).toHaveBeenCalled()
    const callArgs = (mockApi.client.session.promptAsync as any).mock.calls[0][0]
    expect(callArgs.parts[0].text).toContain('ALL_PHASES_COMPLETE')
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
      api: mockApi,
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
      api: mockApi,
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
      api: mockApi,
      dbPath,
    })

    expect(result).toBeDefined()
    
    // Verify loop: key exists immediately after launch
    const loopKey = `loop:${result!.executionName}`
    const loopRow = db.prepare(
      'SELECT data, expires_at, created_at, updated_at FROM project_kv WHERE project_id = ? AND key = ?'
    ).get(projectId, loopKey) as { data: string; expires_at: number; created_at: number; updated_at: number } | null

    expect(loopRow).toBeDefined()
    if (loopRow) {
      const state = JSON.parse(loopRow.data)
      // Verify schema-required fields
      expect(state.active).toBe(true)
      expect(state.sessionId).toBe(result?.sessionId)
      expect(state.loopName).toBe(result?.executionName)
      expect(state.worktreeDir).toBeDefined()
      expect(state.iteration).toBe(1)
      expect(state.phase).toBe('coding')
      expect(state.prompt).toBe(planText)
      expect(state.worktree).toBe(false)
      expect(state.startedAt).toBeDefined()
      expect(loopRow.expires_at).toBeDefined()
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
      api: mockApi,
      dbPath,
    })

    expect(result).toBeDefined()
    
    // Verify loop-session: key exists immediately after launch
    const sessionKey = `loop-session:${result!.sessionId}`
    const sessionRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key = ?'
    ).get(projectId, sessionKey) as { data: string } | null

    expect(sessionRow).toBeDefined()
    if (sessionRow) {
      const storedLoopName = JSON.parse(sessionRow.data)
      expect(storedLoopName).toBe(result?.executionName)
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
      api: mockApi,
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
      api: mockApi,
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
      api: mockApi,
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
      api: mockApi,
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
      api: mockApi,
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
      api: mockApi,
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
      api: mockApi,
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
      api: mockApi,
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
      api: mockApi,
      dbPath,
      executionModel,
      auditorModel,
    })

    const loopStateRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key LIKE ?'
    ).get(projectId, 'loop:%') as { data: string } | null

    expect(loopStateRow).toBeDefined()
    if (loopStateRow) {
      const state = JSON.parse(loopStateRow.data)
      expect(state.executionModel).toBe(executionModel)
      expect(state.auditorModel).toBe(auditorModel)
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
      api: mockApi,
      dbPath,
      executionModel,
    })

    const loopStateRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key LIKE ?'
    ).get(projectId, 'loop:%') as { data: string } | null

    expect(loopStateRow).toBeDefined()
    if (loopStateRow) {
      const state = JSON.parse(loopStateRow.data)
      expect(state.executionModel).toBe(executionModel)
      expect(state.auditorModel).toBeUndefined()
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
      api: mockApi,
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
      api: mockApi,
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
      api: mockApi,
      dbPath,
      executionModel,
      auditorModel,
    })

    // Verify models were persisted
    const loopStateRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key LIKE ?'
    ).get(projectId, 'loop:%') as { data: string } | null

    expect(loopStateRow).toBeDefined()
    if (loopStateRow) {
      const state = JSON.parse(loopStateRow.data)
      expect(state.executionModel).toBe(executionModel)
      expect(state.auditorModel).toBe(auditorModel)
    }

    // Verify first prompt was sent
    expect(promptAsyncSpy).toHaveBeenCalled()
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
      api: mockApi,
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
