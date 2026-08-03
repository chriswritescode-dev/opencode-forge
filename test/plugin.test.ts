import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createForgePlugin } from '../src/index'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import type { PluginConfig } from '../src/types'
import type { PluginInput } from '@opencode-ai/plugin'
import { initializeDatabase, closeDatabase, createLoopsRepo, createPlansRepo, createFeatureGroupsRepo, createSessionSandboxPreferencesRepo } from '../src/storage'

const TEST_DIR = '/tmp/opencode-manager-memory-test-' + Date.now()

const TEST_PROJECT_ID = 'test-proj-id-' + Date.now()

/**
 * Builds a plugin `client` whose HTTP transport resolves `session.get` to a session whose
 * directory is `dir`. The session directory lookup must positively prove ownership before the
 * controller acts on a shared preference row; a client that cannot resolve a session means the
 * instance is not its owner. See `createSessionDirectoryLookup` in `src/index.ts`.
 */
function sessionResolvingClient(dir: string) {
  const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const m = url.match(/\/session\/([^/?]+)/)
    if (m) {
      const sessionID = decodeURIComponent(m[1])
      return new Response(JSON.stringify({ id: sessionID, projectID: TEST_PROJECT_ID, directory: dir, parentID: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { _client: { getConfig: () => ({ fetch: mockFetch }) } }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nonResolvingClient() {
  const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const m = url.match(/\/session\/([^/?]+)/)
    if (m) {
      const sessionID = decodeURIComponent(m[1])
      return new Response(JSON.stringify({ id: sessionID, directory: null, parentID: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { _client: { getConfig: () => ({ fetch: mockFetch }) } }
}

describe('createForgePlugin', () => {
  let testDir: string
  let currentHooks: { getCleanup?: () => Promise<void> } | null

  beforeEach(() => {
    testDir = TEST_DIR + '-' + Math.random().toString(36).slice(2)
    mkdirSync(testDir, { recursive: true })
    currentHooks = null
  })

  afterEach(async () => {
    if (currentHooks?.getCleanup) {
      await currentHooks.getCleanup()
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('Factory creates plugin with valid config', () => {
    const config: PluginConfig = {}

    const plugin = createForgePlugin(config)
    expect(typeof plugin).toBe('function')
  })









  test('Plugin initialization creates database file', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const plugin = createForgePlugin(config)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    const dbPath = `${testDir}/.opencode/memory/forge.db`
    expect(existsSync(dbPath)).toBe(true)
  })

  test('Plugin registers all expected tools', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const plugin = createForgePlugin(config)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    expect(hooks.tool).toBeDefined()
    // Memory CRUD tools are NOT registered
    expect(hooks.tool?.['memory-read']).toBeUndefined()
    expect(hooks.tool?.['memory-write']).toBeUndefined()
    expect(hooks.tool?.['memory-delete']).toBeUndefined()
    expect(hooks.tool?.['memory-health']).toBeUndefined()
    // Plan/review tools should be registered
    expect(hooks.tool?.['plan-read']).toBeDefined()
    expect(hooks.tool?.['plan-edit']).toBeDefined()
    expect(hooks.tool?.['plan-write']).toBeDefined()
    const planWrite = hooks.tool?.['plan-write']
    const contentDescription = (planWrite?.args.content as { description?: string } | undefined)?.description ?? ''
    const planWriteDescriptions = `${planWrite?.description ?? ''} ${contentDescription}`
    expect(planWriteDescriptions).toContain('stored for the current session')
    expect(planWriteDescriptions).not.toContain('forge-plan:start')
    expect(planWriteDescriptions).not.toContain('forge-plan:end')
    expect(planWriteDescriptions).not.toContain('Outer plan markers')
    expect(hooks.tool?.['review-read']).toBeDefined()
    expect(hooks.tool?.['review-write']).toBeDefined()
    // Ast-grep tools should NOT be registered
    expect(hooks.tool?.['ast-grep-search']).toBeUndefined()
    expect(hooks.tool?.['ast-grep-scan']).toBeUndefined()
    // Loop tools should be registered
    expect(hooks.tool?.['execute-plan']).toBeDefined()
    expect(hooks.tool?.['execute-goal']).toBeDefined()
    expect(hooks.tool?.['loop-cancel']).toBeDefined()
    expect(hooks.tool?.['loop-status']).toBeDefined()
  })

  test('Plugin does NOT register shadow glob or grep tools', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: {
        mode: 'sbx',
      },
    }

    const plugin = createForgePlugin(config)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    expect(hooks.tool).toBeDefined()
    expect(hooks.tool?.['glob']).toBeUndefined()
    expect(hooks.tool?.['grep']).toBeUndefined()
  })

  test('Plugin registers all expected hooks', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const plugin = createForgePlugin(config)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    expect(hooks.config).toBeDefined()
    expect(hooks['chat.message']).toBeDefined()
    expect(hooks.event).toBeDefined()
    expect(hooks['experimental.session.compacting']).toBeDefined()
  })

  test('Plugin uses project.id from input', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const plugin = createForgePlugin(config)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    expect(hooks.tool).toBeDefined()
  })

  test('Plugin accepts minimal config', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const plugin = createForgePlugin(config)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    expect(hooks.tool).toBeDefined()
  })

  test('REGRESSION: server.instance.disposed event awaits cleanup and removes process listeners', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const plugin = createForgePlugin(config)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const baselineSigintListeners = process.listenerCount('SIGINT')
    const baselineSigtermListeners = process.listenerCount('SIGTERM')
    const baselineExitListeners = process.listenerCount('exit')

    const hooks = await plugin(mockInput)
    const typedHooks = hooks as { getCleanup?: () => Promise<void>; event: (input: unknown) => Promise<void> }
    currentHooks = typedHooks

    expect(process.listenerCount('SIGINT')).toBeGreaterThan(baselineSigintListeners)
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(baselineSigtermListeners)
    expect(process.listenerCount('exit')).toBeGreaterThan(baselineExitListeners)

    await typedHooks.event({ event: { type: 'server.instance.disposed', properties: {} } } as never)

    expect(process.listenerCount('SIGINT')).toBe(baselineSigintListeners)
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigtermListeners)
    expect(process.listenerCount('exit')).toBe(baselineExitListeners)

    const cleanupFn = typedHooks.getCleanup
    if (cleanupFn) {
      const secondCleanupCall = cleanupFn()
      await expect(secondCleanupCall).resolves.toBeUndefined()
    }
  })



  test('REGRESSION: repeated plugin instances after disposal maintain stable cleanup', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const baselineSigintListeners = process.listenerCount('SIGINT')

    const plugin = createForgePlugin(config)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks1 = await plugin(mockInput)
    const typedHooks1 = hooks1 as { getCleanup?: () => Promise<void>; event: (input: unknown) => Promise<void> }
    await typedHooks1.event({ event: { type: 'server.instance.disposed', properties: {} } } as never)

    const hooks2 = await plugin(mockInput)
    const typedHooks2 = hooks2 as { getCleanup?: () => Promise<void> }
    currentHooks = typedHooks2

    const cleanupFn2 = typedHooks2.getCleanup
    if (cleanupFn2) {
      await cleanupFn2()
    }

    expect(process.listenerCount('SIGINT')).toBe(baselineSigintListeners)
  })

  test('registers forge workspace adapter on init', async () => {
    const registerCalls: Array<{ type: string; adapter: unknown }> = []
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const plugin = createForgePlugin(config)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
      experimental_workspace: {
        register: (type: string, adapter: unknown) => { registerCalls.push({ type, adapter }) },
      },
    }

    const hooks = await plugin(mockInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    expect(registerCalls.length).toBe(1)
    expect(registerCalls[0].type).toBe('forge')
    const adapter = registerCalls[0].adapter as Record<string, unknown>
    expect(typeof adapter.configure).toBe('function')
    expect(typeof adapter.create).toBe('function')
    expect(typeof adapter.remove).toBe('function')
    expect(typeof adapter.target).toBe('function')
  })

  test('does not mutate persisted running loops on plugin initialization', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const plugin = createForgePlugin(config)

    const db = initializeDatabase(config.dataDir!)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)

    const preInsertRow = {
      projectId: TEST_PROJECT_ID,
      loopName: 'interrupted-loop',
      status: 'running' as const,
      currentSessionId: 'old-session',
      worktree: false,
      worktreeDir: testDir,
      worktreeBranch: null,
      projectDir: testDir,
      maxIterations: 50,
      iteration: 3,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding' as const,
      executionModel: null,
      auditorModel: null,
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      startedAt: Date.now() - 10000,
      completedAt: null,
      terminationReason: null,
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: 0,
    }

    loopsRepo.insert(preInsertRow, { lastAuditResult: null })
    closeDatabase(db)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    const dbAfter = initializeDatabase(config.dataDir!)
    const loopsRepoAfter = createLoopsRepo(dbAfter)
    const rowAfter = loopsRepoAfter.get(TEST_PROJECT_ID, 'interrupted-loop')

    expect(rowAfter).not.toBeNull()
    expect(rowAfter!.status).toBe('running')
    expect(rowAfter!.currentSessionId).toBe('old-session')
    expect(rowAfter!.iteration).toBe(3)
    expect(rowAfter!.terminationReason).toBeNull()
    expect(rowAfter!.completedAt).toBeNull()

    closeDatabase(dbAfter)
  })

  test('does not restore or mutate persisted running sandbox loops on plugin initialization', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const plugin = createForgePlugin(config)

    const db = initializeDatabase(config.dataDir!)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)

    const preInsertRow = {
      projectId: TEST_PROJECT_ID,
      loopName: 'sandbox-loop',
      status: 'running' as const,
      currentSessionId: 'sandbox-session',
      worktree: true,
      worktreeDir: testDir,
      worktreeBranch: null,
      projectDir: testDir,
      maxIterations: 50,
      iteration: 2,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding' as const,
      executionModel: null,
      auditorModel: null,
      modelFailed: false,
      sandbox: true,
      sandboxContainer: 'pre-existing-container-name',
      startedAt: Date.now() - 10000,
      completedAt: null,
      terminationReason: null,
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: 0,
    }

    loopsRepo.insert(preInsertRow, { lastAuditResult: null })
    closeDatabase(db)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    const dbAfter = initializeDatabase(config.dataDir!)
    const loopsRepoAfter = createLoopsRepo(dbAfter)
    const rowAfter = loopsRepoAfter.get(TEST_PROJECT_ID, 'sandbox-loop')

    expect(rowAfter).not.toBeNull()
    expect(rowAfter!.status).toBe('running')
    expect(rowAfter!.currentSessionId).toBe('sandbox-session')
    expect(rowAfter!.iteration).toBe(2)
    expect(rowAfter!.terminationReason).toBeNull()
    expect(rowAfter!.completedAt).toBeNull()
    expect(rowAfter!.sandbox).toBe(true)
    expect(rowAfter!.sandboxContainer).toBe('pre-existing-container-name')

    closeDatabase(dbAfter)
  })

  test('marks previously-running feature groups as interrupted on startup (no auto-resume)', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
    }

    const plugin = createForgePlugin(config)

    // Pre-populate DB with a running feature group with features
    const db = initializeDatabase(config.dataDir!)
    const featureGroupsRepo = createFeatureGroupsRepo(db)
    featureGroupsRepo.createGroup({
      projectId: TEST_PROJECT_ID,
      groupId: 'startup-group-1',
      title: 'Startup Test Group',
      status: 'running',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
    })
    featureGroupsRepo.insertFeatures(TEST_PROJECT_ID, 'startup-group-1', [
      { title: 'Feature A', description: 'Desc A' },
    ])
    // Also pre-populate a completed group (should not be touched)
    featureGroupsRepo.createGroup({
      projectId: TEST_PROJECT_ID,
      groupId: 'startup-group-2',
      title: 'Completed Group',
      status: 'completed',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
      completedAt: Date.now(),
    })
    closeDatabase(db)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    // Verify after plugin init
    const dbAfter = initializeDatabase(config.dataDir!)
    const featureGroupsRepoAfter = createFeatureGroupsRepo(dbAfter)

    const group1 = featureGroupsRepoAfter.getGroup(TEST_PROJECT_ID, 'startup-group-1')
    expect(group1).not.toBeNull()
    expect(group1!.status).toBe('interrupted')

    // Running group features are untouched
    const features1 = featureGroupsRepoAfter.listFeatures(TEST_PROJECT_ID, 'startup-group-1')
    expect(features1).toHaveLength(1)
    expect(features1[0].title).toBe('Feature A')
    expect(features1[0].stage).toBe('pending') // inserted as pending, not changed by markInterrupted

    // Completed group unchanged
    const group2 = featureGroupsRepoAfter.getGroup(TEST_PROJECT_ID, 'startup-group-2')
    expect(group2).not.toBeNull()
    expect(group2!.status).toBe('completed')

    closeDatabase(dbAfter)
  })

  test('Plugin initializes successfully with sandbox.enabled=false', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: { mode: 'sbx', enabled: false },
    }

    const plugin = createForgePlugin(config)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput as unknown as PluginInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    expect(hooks).toBeDefined()
    expect(typeof hooks).toBe('object')
  })

  test('Logs legacy sandbox config warnings for a Docker config', async () => {
    const logFile = join(testDir, 'forge.log')
    const legacySandbox = {
      mode: 'docker',
      projectMountPath: '/workspace',
      resources: { shmSize: '64m', memorySwap: '1g' },
      network: { hostGateway: 'host.docker.internal' },
      mounts: [{ host: '/host', container: '/container' }],
    }
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      logging: { enabled: true, file: logFile },
      sandbox: legacySandbox as PluginConfig['sandbox'],
    }

    const plugin = createForgePlugin(config)
    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput as unknown as PluginInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    const logContents = readFileSync(logFile, 'utf-8')
    expect(logContents).toContain("sandbox.mode 'docker' is ignored")
    expect(logContents).toContain('sandbox.projectMountPath is ignored')
    expect(logContents).toContain('sandbox.resources.shmSize is ignored')
    expect(logContents).toContain('sandbox.resources.memorySwap is ignored')
    expect(logContents).toContain('sandbox.network.hostGateway is ignored')
    expect(logContents).toContain('sandbox.mounts[].container is ignored')
  })

  test('Logs loop.permissions config warnings for a bad config on plugin init', async () => {
    const logFile = join(testDir, 'forge.log')
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      logging: { enabled: true, file: logFile },
      loop: { permissions: { deny: ['*'] } },
    }

    const plugin = createForgePlugin(config)
    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput as unknown as PluginInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    const logContents = readFileSync(logFile, 'utf-8')
    expect(logContents).toContain('loop.permissions.deny entry "*" is ignored')
  })

  test('host session sandbox startup does not block init and routing waits fail-closed', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: { mode: 'sbx', enabled: false },
    }

    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(TEST_PROJECT_ID, {
      version: 1,
      revision: 'r-init',
      enabled: true,
      sessionId: 'ses-root',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    let releaseFirstLookup!: () => void
    let lookupCount = 0
    const firstLookup = new Promise<Response>((resolve) => {
      releaseFirstLookup = () => resolve(new Response(JSON.stringify({ id: 'ses-root', projectID: TEST_PROJECT_ID, directory: testDir, parentID: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    })
    const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const match = url.match(/\/session\/([^/?]+)/)
      if (!match) return new Response(JSON.stringify({}), { status: 200 })
      lookupCount += 1
      if (lookupCount === 1) return firstLookup
      const sessionID = decodeURIComponent(match[1]!)
      return new Response(JSON.stringify({ id: sessionID, projectID: TEST_PROJECT_ID, directory: testDir, parentID: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const plugin = createForgePlugin(config)
    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: { _client: { getConfig: () => ({ fetch: mockFetch }) } } as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput as unknown as PluginInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    let db = initializeDatabase(config.dataDir!)
    let preferences = createSessionSandboxPreferencesRepo(db)
    expect(preferences.getApplied(TEST_PROJECT_ID)).toBeNull()
    expect(preferences.getControllerState(TEST_PROJECT_ID)?.phase).toBe('loading')
    closeDatabase(db)

    const shellEnv = hooks['shell.env'] as (
      input: { sessionID?: string; cwd?: string },
      output: { env: Record<string, string> },
    ) => Promise<void>
    let routingSettled = false
    const routing = shellEnv({ sessionID: 'ses-root', cwd: testDir }, { env: {} }).then(
      () => null,
      (err: unknown) => err,
    ).finally(() => {
      routingSettled = true
    })
    await Promise.resolve()
    expect(routingSettled).toBe(false)

    releaseFirstLookup()
    expect(await routing).toBeInstanceOf(Error)

    db = initializeDatabase(config.dataDir!)
    preferences = createSessionSandboxPreferencesRepo(db)
    const appliedAfterStart = preferences.getApplied(TEST_PROJECT_ID)
    expect(appliedAfterStart?.revision).toBe('r-init')
    expect(preferences.getControllerState(TEST_PROJECT_ID)?.phase).toBe('ready')
    closeDatabase(db)

    await currentHooks.getCleanup!()

    db = initializeDatabase(config.dataDir!)
    const appliedAfterCleanup = createSessionSandboxPreferencesRepo(db).getApplied(TEST_PROJECT_ID)
    expect(appliedAfterCleanup).not.toBeNull()
    expect(appliedAfterCleanup!.enabled).toBe(false)
    expect(appliedAfterCleanup!.error).toBeNull()
    expect(appliedAfterCleanup!.revision).toBe('r-init')
    closeDatabase(db)
  })

  test('a transient ancestry lookup failure does not block native tools in tool.execute.before', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: { mode: 'sbx' },
    }

    const plugin = createForgePlugin(config)
    // A client whose session.get throws a transient (non-not-found) error makes the loop resolver's
    // ancestor walk fail, simulating a temporary network/DB failure during tool routing.
    const failingFetch = async (_input: RequestInfo | URL): Promise<Response> => {
      throw new Error('connection refused')
    }
    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: { _client: { getConfig: () => ({ fetch: failingFetch }) } } as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput as unknown as PluginInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    const beforeHook = hooks['tool.execute.before'] as (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: unknown },
    ) => Promise<void>

    // A native host-side tool must not be rejected by a transient loop-ancestry lookup failure.
    await expect(
      beforeHook({ tool: 'read', sessionID: 'ses-native', callID: 'c1' }, { args: {} }),
    ).resolves.toBeUndefined()
    await expect(
      beforeHook({ tool: 'edit', sessionID: 'ses-native', callID: 'c2' }, { args: {} }),
    ).resolves.toBeUndefined()
    await expect(
      beforeHook({ tool: 'write', sessionID: 'ses-native', callID: 'c3' }, { args: {} }),
    ).resolves.toBeUndefined()

    await currentHooks.getCleanup!()
  })

  test('shell.env retains host behavior for sessions with no sandbox via the unified resolver', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: { mode: 'sbx' },
    }

    const plugin = createForgePlugin(config)
    const mockInput = {
      directory: testDir,
      worktree: testDir,
      // The plugin's forged client must resolve session.get as a definitive absence (no parent)
      // so the unified resolver's ancestor walk stays quiet and does not hit the network.
      client: sessionResolvingClient(testDir) as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput as unknown as PluginInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    const shellEnv = hooks['shell.env'] as (
      input: { sessionID?: string; cwd?: string },
      output: { env: Record<string, string> },
    ) => Promise<void>

    // No active loop and no acknowledged host sandbox: the unified resolver returns null and no
    // container env is injected (no user shell configured either), so the shim falls through.
    const output = { env: {} as Record<string, string> }
    await shellEnv({ sessionID: 'ses-unrelated', cwd: testDir }, output)
    expect(output.env).toEqual({})
  })

  test('a failed host-sandbox start makes the selected session fail closed while others stay host', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: { mode: 'sbx' },
    }

    // Persist a desired ON for a selected session. Sandbox routing stays enabled so this exercises
    // a genuine container-start failure rather than the unavailable-runtime path; `sbx` is forced
    // off PATH below so the start fails whether or not the CLI is installed on the host.
    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(TEST_PROJECT_ID, {
      version: 1,
      revision: 'r-fail',
      enabled: true,
      sessionId: 'ses-selected',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const plugin = createForgePlugin(config)
    const mockInput = {
      directory: testDir,
      worktree: testDir,
      // The session directory lookup must positively prove this instance owns the selected
      // session (its directory resolves to this instance's directory) for the fail-closed path to
      // engage. With a directory-scoped lookup that returns null, the instance is not the owner and
      // must not act on the shared preference row at all.
      client: sessionResolvingClient(testDir) as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const originalPath = process.env.PATH
    process.env.PATH = join(testDir, 'no-such-bin')
    try {
      const hooks = await plugin(mockInput as unknown as PluginInput)
      currentHooks = hooks as { getCleanup?: () => Promise<void> }

      const shellEnv = hooks['shell.env'] as (
        input: { sessionID?: string; cwd?: string },
        output: { env: Record<string, string> },
      ) => Promise<void>

      // The selected session's start failed, so bash for it must fail closed (throw) rather than
      // fall through to the host shell.
      await expect(shellEnv({ sessionID: 'ses-selected', cwd: testDir }, { env: {} })).rejects.toThrow()

      // An unrelated host session is unaffected and falls through to the host shell.
      const output = { env: {} as Record<string, string> }
      await shellEnv({ sessionID: 'ses-unrelated', cwd: testDir }, output)
      expect(output.env).toEqual({})

      await currentHooks.getCleanup!()
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  test('two plugin instances for one project share a single refcounted sandbox controller', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: { mode: 'sbx', enabled: false },
    }

    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(TEST_PROJECT_ID, {
      version: 1,
      revision: 'r-shared',
      enabled: true,
      sessionId: 'ses-root',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: sessionResolvingClient(testDir) as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    // OpenCode can instantiate the plugin more than once for the same directory in one process.
    // A second reconciler would race the first on the same container, so both instances must
    // resolve to one shared controller.
    const hooksA = await createForgePlugin(config)(mockInput as unknown as PluginInput)
    const hooksB = await createForgePlugin(config)(mockInput as unknown as PluginInput)
    const cleanupA = (hooksA as unknown as { getCleanup: () => Promise<void> }).getCleanup
    const cleanupB = (hooksB as unknown as { getCleanup: () => Promise<void> }).getCleanup

    const shellEnv = hooksB['shell.env'] as (
      input: { sessionID?: string; cwd?: string },
      output: { env: Record<string, string> },
    ) => Promise<void>
    await expect(shellEnv({ sessionID: 'ses-root', cwd: testDir }, { env: {} })).rejects.toThrow(/unavailable/)

    // The fail-closed start recorded an error; disposal is what clears it to a confirmed OFF.
    let db = initializeDatabase(config.dataDir!)
    expect(createSessionSandboxPreferencesRepo(db).getApplied(TEST_PROJECT_ID)?.error).toBeTruthy()
    closeDatabase(db)

    // Releasing the first instance must not dispose the shared controller while the second still
    // holds a reference: the acknowledgement stays at the start-time failure.
    await cleanupA()
    db = initializeDatabase(config.dataDir!)
    expect(createSessionSandboxPreferencesRepo(db).getApplied(TEST_PROJECT_ID)?.error).toBeTruthy()
    closeDatabase(db)

    // The last release disposes it, clearing the error to a confirmed-stopped OFF.
    await cleanupB()
    db = initializeDatabase(config.dataDir!)
    const applied = createSessionSandboxPreferencesRepo(db).getApplied(TEST_PROJECT_ID)
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toBeNull()
    closeDatabase(db)
  })

  test('a forge worktree instance initializing first still reconciles the root session via project.worktree', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: { mode: 'sbx', enabled: false },
    }
    const projectRoot = join(testDir, 'root')
    const worktreeDir = join(testDir, 'worktree')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(worktreeDir, { recursive: true })

    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(TEST_PROJECT_ID, {
      version: 1,
      revision: 'r-root',
      enabled: true,
      sessionId: 'ses-root',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const worktreeHooks = await createForgePlugin(config)({
      directory: worktreeDir,
      worktree: projectRoot,
      client: sessionResolvingClient(projectRoot) as never,
      project: { id: TEST_PROJECT_ID, worktree: projectRoot } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    } as unknown as PluginInput)
    const rootHooks = await createForgePlugin(config)({
      directory: projectRoot,
      worktree: projectRoot,
      client: sessionResolvingClient(projectRoot) as never,
      project: { id: TEST_PROJECT_ID, worktree: projectRoot } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    } as unknown as PluginInput)
    currentHooks = rootHooks as { getCleanup?: () => Promise<void> }
    const cleanupWorktree = (worktreeHooks as unknown as { getCleanup: () => Promise<void> }).getCleanup

    const shellEnv = rootHooks['shell.env'] as (
      input: { sessionID?: string; cwd?: string },
      output: { env: Record<string, string> },
    ) => Promise<void>

    await expect(shellEnv({ sessionID: 'ses-root', cwd: projectRoot }, { env: {} })).rejects.toThrow(/unavailable/)

    let db = initializeDatabase(config.dataDir!)
    const applied = createSessionSandboxPreferencesRepo(db).getApplied(TEST_PROJECT_ID)
    closeDatabase(db)
    expect(applied?.revision).toBe('r-root')
    expect(applied?.error).toBeTruthy()

    await cleanupWorktree()
  })

  test('a later forge worktree instance cannot leave a root-session toggle pending', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: { mode: 'sbx', enabled: false },
    }
    const projectRoot = join(testDir, 'root')
    const worktreeDir = join(testDir, 'worktree')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(worktreeDir, { recursive: true })

    const rootHooks = await createForgePlugin(config)({
      directory: projectRoot,
      worktree: projectRoot,
      client: sessionResolvingClient(projectRoot) as never,
      project: { id: TEST_PROJECT_ID, worktree: projectRoot } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    } as unknown as PluginInput)
    const worktreeHooks = await createForgePlugin(config)({
      directory: worktreeDir,
      worktree: projectRoot,
      client: nonResolvingClient() as never,
      project: { id: TEST_PROJECT_ID, worktree: projectRoot } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    } as unknown as PluginInput)
    const cleanupRoot = (rootHooks as unknown as { getCleanup: () => Promise<void> }).getCleanup
    const cleanupWorktree = (worktreeHooks as unknown as { getCleanup: () => Promise<void> }).getCleanup
    currentHooks = null

    try {
      const writerDb = initializeDatabase(config.dataDir!)
      createSessionSandboxPreferencesRepo(writerDb).setDesired(TEST_PROJECT_ID, {
        version: 1,
        revision: 'r-root-after-worktree',
        enabled: true,
        sessionId: 'ses-root',
        requestedAt: Date.now(),
      })
      closeDatabase(writerDb)

      await sleep(1200)

      const readerDb = initializeDatabase(config.dataDir!)
      const applied = createSessionSandboxPreferencesRepo(readerDb).getApplied(TEST_PROJECT_ID)
      closeDatabase(readerDb)
      expect(applied?.revision).toBe('r-root-after-worktree')
      expect(applied?.error).toBeTruthy()
    } finally {
      await cleanupWorktree()
      await cleanupRoot()
    }
  })

  test('after the creating instance is disposed, a survivor processes a new desired revision without closed-db callback failure', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: { mode: 'sbx', enabled: false },
    }

    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(TEST_PROJECT_ID, {
      version: 1,
      revision: 'r1',
      enabled: true,
      sessionId: 'ses-1',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const hooksA = await createForgePlugin(config)({
      directory: testDir,
      worktree: testDir,
      client: nonResolvingClient() as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    } as unknown as PluginInput)
    const hooksB = await createForgePlugin(config)({
      directory: testDir,
      worktree: testDir,
      client: sessionResolvingClient(testDir) as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    } as unknown as PluginInput)
    const cleanupA = (hooksA as unknown as { getCleanup: () => Promise<void> }).getCleanup
    currentHooks = hooksB as unknown as { getCleanup?: () => Promise<void> }

    const shellEnvB = hooksB['shell.env'] as (
      input: { sessionID?: string; cwd?: string },
      output: { env: Record<string, string> },
    ) => Promise<void>
    await expect(shellEnvB({ sessionID: 'ses-1', cwd: testDir }, { env: {} })).rejects.toThrow(/unavailable/)

    await cleanupA()

    const writerDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(writerDb).setDesired(TEST_PROJECT_ID, {
      version: 1,
      revision: 'r2',
      enabled: true,
      sessionId: 'ses-2',
      requestedAt: Date.now(),
    })
    closeDatabase(writerDb)

    let applied: { revision: string | null; error: string | null } | null = null
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const pollDb = initializeDatabase(config.dataDir!)
      const row = createSessionSandboxPreferencesRepo(pollDb).getApplied(TEST_PROJECT_ID)
      closeDatabase(pollDb)
      if (row?.revision === 'r2') {
        applied = { revision: row.revision, error: row.error }
        break
      }
      await sleep(50)
    }
    expect(applied?.revision).toBe('r2')
    expect(applied?.error).toBeTruthy()
  })

  test('unavailable sandbox runtime acknowledges a requested ON as OFF-with-error and blocks the selected session', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: { mode: 'sbx', enabled: false },
    }

    // Persist a desired ON for a selected session. Sandbox routing is unavailable (disabled), so
    // startup reconciliation must still create a controller that acknowledges the request as
    // OFF-with-error at the matching revision and blocks the selected session fail-closed.
    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(TEST_PROJECT_ID, {
      version: 1,
      revision: 'r-unavail',
      enabled: true,
      sessionId: 'ses-selected',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const plugin = createForgePlugin(config)
    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: sessionResolvingClient(testDir) as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput as unknown as PluginInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    const shellEnv = hooks['shell.env'] as (
      input: { sessionID?: string; cwd?: string },
      output: { env: Record<string, string> },
    ) => Promise<void>
    await expect(shellEnv({ sessionID: 'ses-selected', cwd: testDir }, { env: {} })).rejects.toThrow(/unavailable/)

    // The unavailable runtime acknowledged the requested ON at the matching revision as OFF with
    // an error, so the TUI sees a definitive server answer rather than a silent host fallback.
    let db = initializeDatabase(config.dataDir!)
    const applied = createSessionSandboxPreferencesRepo(db).getApplied(TEST_PROJECT_ID)
    expect(applied).not.toBeNull()
    expect(applied!.revision).toBe('r-unavail')
    expect(applied!.enabled).toBe(false)
    expect(applied!.error).toBeTruthy()
    closeDatabase(db)

    // An unrelated host session is unaffected and falls through to the host shell.
    const output = { env: {} as Record<string, string> }
    await shellEnv({ sessionID: 'ses-unrelated', cwd: testDir }, output)
    expect(output.env).toEqual({})

    await currentHooks.getCleanup!()
  })

  test('manager initialization failure still acknowledges a requested ON as OFF-with-error', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      // Sandbox routing is disabled so the deterministic unavailable manager is used (ensureRunning
      // fails closed, stop is a no-op). This makes the OFF-with-error acknowledgement independent of
      // whether the `sbx` CLI is installed on the host, exercising the same fail-closed surface as a
      // manager that fails to initialize.
      sandbox: { mode: 'sbx', enabled: false },
    }

    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(TEST_PROJECT_ID, {
      version: 1,
      revision: 'r-manager-fail',
      enabled: true,
      sessionId: 'ses-selected',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const plugin = createForgePlugin(config)
    const mockInput = {
      directory: testDir,
      worktree: testDir,
      client: sessionResolvingClient(testDir) as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const hooks = await plugin(mockInput as unknown as PluginInput)
    currentHooks = hooks as { getCleanup?: () => Promise<void> }

    const shellEnv = hooks['shell.env'] as (
      input: { sessionID?: string; cwd?: string },
      output: { env: Record<string, string> },
    ) => Promise<void>
    await expect(shellEnv({ sessionID: 'ses-selected', cwd: testDir }, { env: {} })).rejects.toThrow(/unavailable/)

    // Regardless of how the manager/shims became unavailable, the requested ON is acknowledged as
    // OFF-with-error at the matching revision (fail closed).
    let db = initializeDatabase(config.dataDir!)
    const applied = createSessionSandboxPreferencesRepo(db).getApplied(TEST_PROJECT_ID)
    expect(applied).not.toBeNull()
    expect(applied!.revision).toBe('r-manager-fail')
    expect(applied!.enabled).toBe(false)
    expect(applied!.error).toBeTruthy()
    closeDatabase(db)

    await currentHooks.getCleanup!()
  })

})

describe('PluginConfig', () => {
  test('Accepts minimal config', () => {
    const config: PluginConfig = {}
    expect(config).toBeDefined()
  })

  test('Accepts custom dataDir', () => {
    const config: PluginConfig = {
      dataDir: '/custom/path/memory',
    }

    expect(config.dataDir).toBe('/custom/path/memory')
  })

  test('Accepts loop config', () => {
    const config: PluginConfig = {
      loop: {
        enabled: true,
        defaultMaxIterations: 10,
      },
    }

    expect(config.loop?.enabled).toBe(true)
  })



  test('Accepts sandbox config', () => {
    const config: PluginConfig = {
      sandbox: {
        mode: 'sbx',
        image: 'custom-image:latest',
      },
    }

    expect(config.sandbox?.mode).toBe('sbx')
  })

  test('Accepts sandbox.enabled flag for opting out of Docker', () => {
    const enabledConfig: PluginConfig = {
      sandbox: { mode: 'sbx', enabled: true },
    }
    const disabledConfig: PluginConfig = {
      sandbox: { mode: 'sbx', enabled: false },
    }

    expect(enabledConfig.sandbox?.enabled).toBe(true)
    expect(disabledConfig.sandbox?.enabled).toBe(false)
  })
})

describe('messages.transform hook', () => {
  let testDir: string
  let hooks: Record<string, Function> & { getCleanup?: () => Promise<void> }

  beforeEach(async () => {
    testDir = TEST_DIR + '-transform-' + Math.random().toString(36).slice(2)
    mkdirSync(testDir, { recursive: true })

    const config: PluginConfig = {
      dataDir: testDir,
    }

    const factory = createForgePlugin(config)
    hooks = await factory({
      client: {
        session: {
          prompt: async () => ({ data: { parts: [{ type: 'text', text: 'ok' }] } }),
          promptAsync: async () => {},
          messages: async () => ({ data: [] }),
          create: async () => ({ data: { id: 'test-session' } }),
          todo: async () => ({ data: [] }),
        },
        app: { log: () => {} },
      },
      project: { id: TEST_PROJECT_ID, worktree: testDir },
      directory: testDir,
      worktree: testDir,
      serverUrl: new URL('http://localhost:5551'),
    } as unknown as PluginInput) as any
  })

  afterEach(async () => {
    if (hooks?.getCleanup) {
      await hooks.getCleanup()
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('injects system-reminder for architect agent messages', async () => {
    const output = {
      messages: [
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'hello' }] },
        { info: { role: 'user', agent: 'architect' }, parts: [{ type: 'text', text: 'plan this' }] },
      ],
    }

    await hooks['experimental.chat.messages.transform']({}, output)

    const userMsg = output.messages[1]
    expect(userMsg.parts).toHaveLength(2)
    expect(userMsg.parts[1]).toMatchObject({
      type: 'text',
      synthetic: true,
    })
    const text = userMsg.parts[1].text as string
    expect(text).toContain('system-reminder')
    expect(text).toContain('READ-ONLY filesystem mode')
    expect(text).toContain('complete stored plan')
    expect(text).toContain('at most 24 phases')
    expect(text).toContain('fix every structure-report warning')
    expect(text).toContain('exactly "New session", "Execute here", "Loop"')
    expect(text).toContain('call `execute-plan` with a short title')
    expect(text).not.toContain('<!-- forge-section -->')
    expect(text).not.toContain('<!-- forge-plan:start -->')
    expect(text).not.toContain('<!-- forge-plan:end -->')
    expect(text).not.toContain('### Files')
  })

  test('does NOT inject for non-architect agents', async () => {
    const output = {
      messages: [
        { info: { role: 'user', agent: 'code' }, parts: [{ type: 'text', text: 'do something' }] },
      ],
    }

    await hooks['experimental.chat.messages.transform']({}, output)

    expect(output.messages[0].parts).toHaveLength(1)
  })

  test('does NOT inject when no user message exists', async () => {
    const output = {
      messages: [
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'response' }] },
      ],
    }

    await hooks['experimental.chat.messages.transform']({}, output)

    expect(output.messages[0].parts).toHaveLength(1)
  })

  test('targets the LAST user message in the array', async () => {
    const output = {
      messages: [
        { info: { role: 'user', agent: 'code' }, parts: [{ type: 'text', text: 'first' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'response' }] },
        { info: { role: 'user', agent: 'architect' }, parts: [{ type: 'text', text: 'second' }] },
      ],
    }

    await hooks['experimental.chat.messages.transform']({}, output)

    expect(output.messages[0].parts).toHaveLength(1)
    expect(output.messages[2].parts).toHaveLength(2)
  })

  test('does not double-inject memory for same message id', async () => {
    const output = {
      messages: [
        { info: { role: 'user', id: 'msg-123' }, parts: [{ type: 'text', text: 'tell me about the project' }] },
      ],
    }

    await hooks['experimental.chat.messages.transform']({}, output)
    const partsAfterFirst = output.messages[0].parts.length

    await hooks['experimental.chat.messages.transform']({}, output)
    const partsAfterSecond = output.messages[0].parts.length

    expect(partsAfterSecond).toBe(partsAfterFirst)
  })

  test('processes messages without id on every call without throwing', async () => {
    const output = {
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'tell me about the project' }] },
      ],
    }

    await hooks['experimental.chat.messages.transform']({}, output)
    const partsAfterFirst = output.messages[0].parts.length

    const output2 = {
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'tell me more' }] },
      ],
    }

    await hooks['experimental.chat.messages.transform']({}, output2)
    const partsAfterSecond = output2.messages[0].parts.length

    expect(partsAfterFirst).toBeGreaterThanOrEqual(1)
    expect(partsAfterSecond).toBeGreaterThanOrEqual(1)
  })

  test('evicts oldest message id after 100 entries', async () => {
    const firstId = 'msg-evict-0'

    const firstOutput = {
      messages: [
        { info: { role: 'user', id: firstId }, parts: [{ type: 'text', text: 'first message' }] },
      ],
    }
    await hooks['experimental.chat.messages.transform']({}, firstOutput)
    const firstInjectionParts = firstOutput.messages[0].parts.length

    for (let i = 1; i <= 100; i++) {
      const output = {
        messages: [
          { info: { role: 'user', id: `msg-evict-${i}` }, parts: [{ type: 'text', text: `message ${i}` }] },
        ],
      }
      await hooks['experimental.chat.messages.transform']({}, output)
    }

    const reOutput = {
      messages: [
        { info: { role: 'user', id: firstId }, parts: [{ type: 'text', text: 'first message again' }] },
      ],
    }
    await hooks['experimental.chat.messages.transform']({}, reOutput)

    expect(reOutput.messages[0].parts.length).toBe(firstInjectionParts)
  })
})
