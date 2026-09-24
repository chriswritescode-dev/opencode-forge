import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { createForgeCore, type ForgeCore, type ForgeHostInput } from '../src/host/forge-core'
import type { PluginConfig } from '../src/types'
import type { ForgeClient, ToastInput } from '../src/client/port'
import type { LoopRow } from '../src/storage'
import {
  initializeDatabase,
  closeDatabase,
  createLoopsRepo,
  createFeatureGroupsRepo,
  createSessionSandboxPreferencesRepo,
} from '../src/storage'
import { createFakeForgeClient, type RecordedCall } from './helpers/fake-client'

const TEST_DIR = '/tmp/opencode-forge-core-plugin-test-' + Date.now()

let projectCounter = 0
function uniqueProjectId(): string {
  return `test-proj-${Date.now()}-${++projectCounter}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Builds a `ForgeClient` whose `session.get` resolves to a session owned by
 * `directory` for `projectId`. Session ownership must be positively proven before a
 * shared host-sandbox preference row is acted on; a client that cannot resolve a
 * session means the instance is not its owner.
 */
function sessionResolvingClient(directory: string, projectId: string): ForgeClient {
  return createFakeForgeClient({
    session: {
      get: async (input: unknown) => {
        const sessionID = (input as { sessionID?: string }).sessionID ?? 'ses_unknown'
        return { id: sessionID, projectID: projectId, directory, parentID: null }
      },
    },
  }).client
}

/**
 * A client whose `session.get` resolves a session with no directory, so ownership
 * is never confirmed. Mirrors the V1 non-resolving transport: the instance cannot
 * prove it owns a session and must not act on the shared preference row.
 */
function nonResolvingClient(projectId: string): ForgeClient {
  return createFakeForgeClient({
    session: {
      get: async (input: unknown) => {
        const sessionID = (input as { sessionID?: string }).sessionID ?? 'ses_unknown'
        return { id: sessionID, projectID: projectId, directory: null, parentID: null }
      },
    },
  }).client
}

/**
 * The ForgeClient port exposes `toast`; the shared test fake predates it. Attach a
 * recorder so a test can observe the toasts Forge publishes.
 */
function recordToasts(client: ForgeClient): ToastInput[] {
  const toasts: ToastInput[] = []
  ;(client as { toast: (input: ToastInput) => Promise<void> }).toast = async (input) => {
    toasts.push(input)
  }
  return toasts
}

function runningLoopRow(projectId: string, directory: string, overrides: Partial<LoopRow> = {}): LoopRow {
  return {
    projectId,
    loopName: 'interrupted-loop',
    status: 'running',
    currentSessionId: 'old-session',
    worktree: false,
    worktreeDir: directory,
    worktreeBranch: null,
    projectDir: directory,
    maxIterations: 50,
    iteration: 3,
    auditCount: 0,
    errorCount: 0,
    phase: 'coding',
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
    executionVariant: null,
    auditorVariant: null,
    kind: 'plan',
    ...overrides,
  }
}

describe('createForgeCore', () => {
  let testDir: string
  let cores: ForgeCore[]

  beforeEach(() => {
    testDir = TEST_DIR + '-' + Math.random().toString(36).slice(2)
    mkdirSync(testDir, { recursive: true })
    cores = []
  })

  afterEach(async () => {
    for (const core of cores.splice(0)) {
      await core.cleanup().catch(() => {})
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  interface BuildCoreOptions {
    config?: PluginConfig
    directory?: string
    projectId?: string
    projectRoot?: string
    client?: ForgeClient
    makeClient?: (projectId: string) => ForgeClient
  }

  async function buildCore(options: BuildCoreOptions = {}): Promise<{
    core: ForgeCore
    calls: RecordedCall[]
    adapters: unknown[]
    client: ForgeClient
    projectId: string
  }> {
    const directory = options.directory ?? testDir
    const projectRoot = options.projectRoot ?? directory
    const projectId = options.projectId ?? uniqueProjectId()
    const adapters: unknown[] = []
    const fake = options.client || options.makeClient ? null : createFakeForgeClient()
    const client = options.client ?? (options.makeClient ? options.makeClient(projectId) : fake!.client)
    const calls: RecordedCall[] = fake?.calls ?? []
    const core = await createForgeCore(
      options.config ?? { dataDir: join(testDir, 'memory') },
      {
        directory,
        projectId,
        projectRoot,
        client,
        registerWorkspaceAdapter: (adapter) => { adapters.push(adapter) },
      } satisfies ForgeHostInput,
    )
    cores.push(core)
    return { core, calls, adapters, client, projectId }
  }

  /** Routes a search tool call through the core's sandbox-before hook. */
  function globBefore(core: ForgeCore, sessionID: string, callID: string): Promise<void> {
    return core.toolBefore({ tool: 'glob', sessionID, callID }, { args: { pattern: '**/*' } })
  }

  test('initialization creates the forge database file', async () => {
    const built = await buildCore({ config: { dataDir: join(testDir, 'memory') } })

    expect(existsSync(join(testDir, 'memory', 'forge.db'))).toBe(true)
    expect(built.core.tools).toBeDefined()
  })

  test('registers all expected tools', async () => {
    const built = await buildCore({ config: { dataDir: join(testDir, 'memory') } })
    const tools = built.core.tools

    // Memory CRUD tools are NOT registered
    expect(tools['memory-read']).toBeUndefined()
    expect(tools['memory-write']).toBeUndefined()
    expect(tools['memory-delete']).toBeUndefined()
    expect(tools['memory-health']).toBeUndefined()
    // Plan/review tools should be registered
    expect(tools['plan-read']).toBeDefined()
    expect(tools['plan-edit']).toBeDefined()
    expect(tools['plan-write']).toBeDefined()
    const planWrite = tools['plan-write']
    const contentDescription = (planWrite?.args.content as { description?: string } | undefined)?.description ?? ''
    const planWriteDescriptions = `${planWrite?.description ?? ''} ${contentDescription}`
    expect(planWriteDescriptions).toContain('stored for the current session')
    expect(planWriteDescriptions).not.toContain('forge-plan:start')
    expect(planWriteDescriptions).not.toContain('forge-plan:end')
    expect(planWriteDescriptions).not.toContain('Outer plan markers')
    expect(tools['review-read']).toBeDefined()
    expect(tools['review-write']).toBeDefined()
    // Ast-grep tools should NOT be registered
    expect(tools['ast-grep-search']).toBeUndefined()
    expect(tools['ast-grep-scan']).toBeUndefined()
    // Loop tools should be registered
    expect(tools['execute-plan']).toBeDefined()
    expect(tools['execute-goal']).toBeDefined()
    expect(tools['loop-cancel']).toBeDefined()
    expect(tools['loop-status']).toBeDefined()
  })

  test('does NOT register shadow glob or grep tools', async () => {
    const built = await buildCore({
      config: { dataDir: join(testDir, 'memory'), sandbox: { mode: 'msb' } },
    })

    expect(built.core.tools['glob']).toBeUndefined()
    expect(built.core.tools['grep']).toBeUndefined()
  })

  test('accepts a minimal config', async () => {
    const built = await buildCore({ config: { dataDir: join(testDir, 'memory') } })

    expect(built.core.tools['plan-read']).toBeDefined()
  })

  test('uses the supplied project id', async () => {
    const projectId = uniqueProjectId()
    const built = await buildCore({ projectId })

    const db = initializeDatabase(join(testDir, 'memory'))
    const loopsRepo = createLoopsRepo(db)
    loopsRepo.insert(runningLoopRow(projectId, testDir), { lastAuditResult: null })
    const row = loopsRepo.get(projectId, 'interrupted-loop')
    closeDatabase(db)

    expect(row).not.toBeNull()
    expect(built.core.tools['plan-read']).toBeDefined()
  })

  test('REGRESSION: cleanup awaits disposal and removes process listeners', async () => {
    const baselineSigint = process.listenerCount('SIGINT')
    const baselineSigterm = process.listenerCount('SIGTERM')
    const baselineExit = process.listenerCount('exit')

    const built = await buildCore({ config: { dataDir: join(testDir, 'memory') } })

    expect(process.listenerCount('SIGINT')).toBeGreaterThan(baselineSigint)
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(baselineSigterm)
    expect(process.listenerCount('exit')).toBeGreaterThan(baselineExit)

    await built.core.cleanup()

    expect(process.listenerCount('SIGINT')).toBe(baselineSigint)
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm)
    expect(process.listenerCount('exit')).toBe(baselineExit)

    await expect(built.core.cleanup()).resolves.toBeUndefined()
  })

  test('REGRESSION: repeated instances after disposal maintain stable cleanup', async () => {
    const baselineSigint = process.listenerCount('SIGINT')

    const first = await buildCore({ config: { dataDir: join(testDir, 'memory') } })
    await first.core.cleanup()

    const second = await buildCore({ config: { dataDir: join(testDir, 'memory') } })
    await second.core.cleanup()

    expect(process.listenerCount('SIGINT')).toBe(baselineSigint)
  })

  test('registers the forge workspace adapter on init', async () => {
    const built = await buildCore({ config: { dataDir: join(testDir, 'memory') } })

    expect(built.adapters).toHaveLength(1)
    const adapter = built.adapters[0] as Record<string, unknown>
    expect(typeof adapter.configure).toBe('function')
    expect(typeof adapter.create).toBe('function')
    expect(typeof adapter.remove).toBe('function')
  })

  test('does not mutate persisted running loops on initialization', async () => {
    const projectId = uniqueProjectId()
    const config: PluginConfig = { dataDir: join(testDir, 'memory') }

    const db = initializeDatabase(config.dataDir!)
    createLoopsRepo(db).insert(runningLoopRow(projectId, testDir), { lastAuditResult: null })
    closeDatabase(db)

    await buildCore({ config, projectId })

    const dbAfter = initializeDatabase(config.dataDir!)
    const rowAfter = createLoopsRepo(dbAfter).get(projectId, 'interrupted-loop')

    expect(rowAfter).not.toBeNull()
    expect(rowAfter!.status).toBe('running')
    expect(rowAfter!.currentSessionId).toBe('old-session')
    expect(rowAfter!.iteration).toBe(3)
    expect(rowAfter!.terminationReason).toBeNull()
    expect(rowAfter!.completedAt).toBeNull()

    closeDatabase(dbAfter)
  })

  test('does not restore or mutate persisted running sandbox loops on initialization', async () => {
    const projectId = uniqueProjectId()
    const config: PluginConfig = { dataDir: join(testDir, 'memory') }

    const db = initializeDatabase(config.dataDir!)
    createLoopsRepo(db).insert(
      runningLoopRow(projectId, testDir, {
        loopName: 'sandbox-loop',
        currentSessionId: 'sandbox-session',
        worktree: true,
        iteration: 2,
        sandbox: true,
        sandboxContainer: 'pre-existing-container-name',
      }),
      { lastAuditResult: null },
    )
    closeDatabase(db)

    await buildCore({ config, projectId })

    const dbAfter = initializeDatabase(config.dataDir!)
    const rowAfter = createLoopsRepo(dbAfter).get(projectId, 'sandbox-loop')

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
    const projectId = uniqueProjectId()
    const config: PluginConfig = { dataDir: join(testDir, 'memory') }

    const db = initializeDatabase(config.dataDir!)
    const featureGroupsRepo = createFeatureGroupsRepo(db)
    featureGroupsRepo.createGroup({
      projectId,
      groupId: 'startup-group-1',
      title: 'Startup Test Group',
      status: 'running',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
    })
    featureGroupsRepo.insertFeatures(projectId, 'startup-group-1', [
      { title: 'Feature A', description: 'Desc A' },
    ])
    featureGroupsRepo.createGroup({
      projectId,
      groupId: 'startup-group-2',
      title: 'Completed Group',
      status: 'completed',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
      completedAt: Date.now(),
    })
    closeDatabase(db)

    await buildCore({ config, projectId })

    const dbAfter = initializeDatabase(config.dataDir!)
    const featureGroupsRepoAfter = createFeatureGroupsRepo(dbAfter)

    const group1 = featureGroupsRepoAfter.getGroup(projectId, 'startup-group-1')
    expect(group1).not.toBeNull()
    expect(group1!.status).toBe('interrupted')

    const features1 = featureGroupsRepoAfter.listFeatures(projectId, 'startup-group-1')
    expect(features1).toHaveLength(1)
    expect(features1[0].title).toBe('Feature A')
    expect(features1[0].stage).toBe('pending')

    const group2 = featureGroupsRepoAfter.getGroup(projectId, 'startup-group-2')
    expect(group2).not.toBeNull()
    expect(group2!.status).toBe('completed')

    closeDatabase(dbAfter)
  })

  test('initializes successfully with sandbox.enabled=false', async () => {
    const built = await buildCore({
      config: { dataDir: join(testDir, 'memory'), sandbox: { mode: 'msb', enabled: false } },
    })

    expect(built.core.tools).toBeDefined()
    expect(built.core.shellShimPath).toBeNull()
  })

  test('init fails closed when the sandbox is enabled but the shell shim cannot be installed', async () => {
    const blocker = join(testDir, 'blocker')
    writeFileSync(blocker, 'x')

    await expect(
      createForgeCore(
        { dataDir: join(blocker, '.opencode', 'memory'), sandbox: { mode: 'msb' } },
        {
          directory: testDir,
          projectId: uniqueProjectId(),
          projectRoot: testDir,
          client: createFakeForgeClient().client,
          registerWorkspaceAdapter: () => {},
        },
      ),
    ).rejects.toThrow(/shell shim unavailable/)
  })

  test('logs legacy sandbox config warnings for a Docker config', async () => {
    const logFile = join(testDir, 'forge.log')
    const legacySandbox = {
      mode: 'docker',
      projectMountPath: '/workspace',
      resources: { shmSize: '64m', memorySwap: '1g' },
      network: { hostGateway: 'host.docker.internal' },
      mounts: [{ host: '/host', container: '/container' }],
    }
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      logging: { enabled: true, file: logFile },
      sandbox: legacySandbox as PluginConfig['sandbox'],
    }

    await buildCore({ config })

    const logContents = readFileSync(logFile, 'utf-8')
    expect(logContents).toContain("sandbox.mode 'docker' is ignored")
    expect(logContents).toContain('sandbox.projectMountPath is ignored')
    expect(logContents).toContain('sandbox.resources.shmSize is ignored')
    expect(logContents).toContain('sandbox.resources.memorySwap is ignored')
    expect(logContents).toContain('sandbox.network.hostGateway is ignored')
    expect(logContents).toContain('sandbox.mounts[].container is ignored')
  })

  test('logs exactly one msb-replacement warning for a legacy sbx-mode config and still initializes', async () => {
    const logFile = join(testDir, 'forge.log')
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      logging: { enabled: true, file: logFile },
      sandbox: { mode: 'sbx', enabled: false } as PluginConfig['sandbox'],
    }

    const built = await buildCore({ config })

    const logContents = readFileSync(logFile, 'utf-8')
    const warningLines = logContents.split('\n').filter((line) => line.includes('sandbox.mode'))
    expect(warningLines).toHaveLength(1)
    expect(warningLines[0]).toContain('msb')
    expect(warningLines[0]).toContain('use mode')
    expect(built.core.tools).toBeDefined()
  })

  test('publishes legacy sandbox config warnings as a toast on init', async () => {
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      sandbox: { mode: 'sbx', enabled: false } as PluginConfig['sandbox'],
    }
    const { client } = createFakeForgeClient()
    const toasts = recordToasts(client)

    await buildCore({ config, client })

    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toBe('Forge sandbox config')
    expect(toasts[0].variant).toBe('warning')
    expect(toasts[0].message).toContain('sandbox.mode')
  })

  test('logs loop.permissions config warnings for a bad config on init', async () => {
    const logFile = join(testDir, 'forge.log')
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      logging: { enabled: true, file: logFile },
      loop: { permissions: { deny: ['*'] } },
    }

    await buildCore({ config })

    const logContents = readFileSync(logFile, 'utf-8')
    expect(logContents).toContain('loop.permissions.deny entry "*" is ignored')
  })

  test('host session sandbox startup does not block init and routing waits fail-closed', async () => {
    const projectId = uniqueProjectId()
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      sandbox: { mode: 'msb', enabled: false },
    }

    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(projectId, {
      version: 1,
      revision: 'r-init',
      enabled: true,
      sessionId: 'ses-root',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    let releaseFirstLookup!: () => void
    let lookupCount = 0
    const firstLookup = new Promise<Record<string, unknown>>((resolve) => {
      releaseFirstLookup = () => resolve({
        id: 'ses-root',
        projectID: projectId,
        directory: testDir,
        parentID: null,
      })
    })
    const { client } = createFakeForgeClient({
      session: {
        get: async (input: unknown) => {
          lookupCount += 1
          if (lookupCount === 1) return firstLookup
          const sessionID = (input as { sessionID?: string }).sessionID ?? 'ses_unknown'
          return { id: sessionID, projectID: projectId, directory: testDir, parentID: null }
        },
      },
    })

    const built = await buildCore({ config, projectId, client })

    let db = initializeDatabase(config.dataDir!)
    let preferences = createSessionSandboxPreferencesRepo(db)
    expect(preferences.getApplied(projectId)).toBeNull()
    expect(preferences.getControllerState(projectId)?.phase).toBe('loading')
    closeDatabase(db)

    let routingSettled = false
    const routing = globBefore(built.core, 'ses-root', 'c1').then(
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
    const appliedAfterStart = preferences.getApplied(projectId)
    expect(appliedAfterStart?.revision).toBe('r-init')
    expect(preferences.getControllerState(projectId)?.phase).toBe('ready')
    closeDatabase(db)

    await built.core.cleanup()

    db = initializeDatabase(config.dataDir!)
    const appliedAfterCleanup = createSessionSandboxPreferencesRepo(db).getApplied(projectId)
    expect(appliedAfterCleanup).not.toBeNull()
    expect(appliedAfterCleanup!.enabled).toBe(false)
    expect(appliedAfterCleanup!.error).toBeNull()
    expect(appliedAfterCleanup!.revision).toBe('r-init')
    closeDatabase(db)
  })

  test('a transient ancestry lookup failure fails host file tools closed but not other native tools', async () => {
    const projectId = uniqueProjectId()
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      sandbox: { mode: 'msb' },
    }
    const failingClient = createFakeForgeClient({
      session: {
        get: async () => {
          throw new Error('connection refused')
        },
      },
    }).client

    const built = await buildCore({ config, projectId, client: failingClient })

    for (const tool of ['read', 'edit', 'write']) {
      await expect(
        built.core.toolBefore({ tool, sessionID: 'ses-native', callID: `c-${tool}` }, { args: {} }),
      ).rejects.toThrow()
    }
    await expect(
      built.core.toolBefore({ tool: 'webfetch', sessionID: 'ses-native', callID: 'c-webfetch' }, { args: {} }),
    ).resolves.toBeUndefined()
  })

  test('resolveShellSandbox retains host behavior for sessions with no sandbox', async () => {
    const projectId = uniqueProjectId()
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      sandbox: { mode: 'msb' },
    }

    const built = await buildCore({
      config,
      projectId,
      makeClient: (id) => sessionResolvingClient(testDir, id),
    })

    // No active loop and no acknowledged host sandbox: the unified resolver returns null, so the
    // shell is not routed into a container.
    await expect(built.core.resolveShellSandbox('ses-unrelated')).resolves.toBeNull()
  })

  test('a failed host-sandbox start makes the selected session fail closed while others stay host', async () => {
    const projectId = uniqueProjectId()
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      sandbox: { mode: 'msb' },
    }

    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(projectId, {
      version: 1,
      revision: 'r-fail',
      enabled: true,
      sessionId: 'ses-selected',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    // Sandbox routing stays enabled so this exercises a genuine container-start failure rather than the
    // unavailable-runtime path; `msb` is forced off PATH so the start fails whether or not the CLI is
    // installed on the host.
    const originalPath = process.env.PATH
    process.env.PATH = join(testDir, 'no-such-bin')
    try {
      const built = await buildCore({
        config,
        projectId,
        makeClient: (id) => sessionResolvingClient(testDir, id),
      })

      // The selected session's start failed, so its shell must fail closed rather than fall through to
      // the host shell.
      await expect(built.core.resolveShellSandbox('ses-selected')).rejects.toThrow(/unavailable/)

      // An unrelated host session is unaffected and falls through to the host shell.
      await expect(built.core.resolveShellSandbox('ses-unrelated')).resolves.toBeNull()

      // Permission auto-approval never applies when the sandbox cannot be resolved or is absent.
      await expect(built.core.autoApprovesPermissions('ses-selected')).resolves.toBe(false)
      await expect(built.core.autoApprovesPermissions('ses-unrelated')).resolves.toBe(false)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  test('two instances for one project share a single refcounted sandbox controller', async () => {
    const projectId = uniqueProjectId()
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      sandbox: { mode: 'msb', enabled: false },
    }

    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(projectId, {
      version: 1,
      revision: 'r-shared',
      enabled: true,
      sessionId: 'ses-root',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const makeClient = (id: string) => sessionResolvingClient(testDir, id)
    // OpenCode can instantiate the plugin more than once for the same directory in one process. A
    // second reconciler would race the first on the same container, so both instances must resolve to
    // one shared controller.
    const first = await buildCore({ config, projectId, makeClient })
    const second = await buildCore({ config, projectId, makeClient })

    await expect(globBefore(second.core, 'ses-root', 'c1')).rejects.toThrow(/unavailable/)

    // The fail-closed start recorded an error; disposal is what clears it to a confirmed OFF.
    let db = initializeDatabase(config.dataDir!)
    expect(createSessionSandboxPreferencesRepo(db).getApplied(projectId)?.error).toBeTruthy()
    closeDatabase(db)

    // Releasing the first instance must not dispose the shared controller while the second still holds a
    // reference: the acknowledgement stays at the start-time failure.
    await first.core.cleanup()
    db = initializeDatabase(config.dataDir!)
    expect(createSessionSandboxPreferencesRepo(db).getApplied(projectId)?.error).toBeTruthy()
    closeDatabase(db)

    // The last release disposes it, clearing the error to a confirmed-stopped OFF.
    await second.core.cleanup()
    db = initializeDatabase(config.dataDir!)
    const applied = createSessionSandboxPreferencesRepo(db).getApplied(projectId)
    expect(applied?.enabled).toBe(false)
    expect(applied?.error).toBeNull()
    closeDatabase(db)
  })

  test('a forge worktree instance initializing first still reconciles the root session', async () => {
    const projectId = uniqueProjectId()
    const dataDir = join(testDir, 'memory')
    const projectRoot = join(testDir, 'root')
    const worktreeDir = join(dataDir, 'worktrees', 'loop-1')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(worktreeDir, { recursive: true })
    const config: PluginConfig = { dataDir, sandbox: { mode: 'msb', enabled: false } }

    const setupDb = initializeDatabase(dataDir)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(projectId, {
      version: 1,
      revision: 'r-root',
      enabled: true,
      sessionId: 'ses-root',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const makeClient = (id: string) => sessionResolvingClient(projectRoot, id)
    await buildCore({ config, projectId, directory: worktreeDir, projectRoot, makeClient })
    const root = await buildCore({ config, projectId, directory: projectRoot, projectRoot, makeClient })

    await expect(globBefore(root.core, 'ses-root', 'c1')).rejects.toThrow(/unavailable/)

    const db = initializeDatabase(dataDir)
    const applied = createSessionSandboxPreferencesRepo(db).getApplied(projectId)
    closeDatabase(db)
    expect(applied?.revision).toBe('r-root')
    expect(applied?.error).toBeTruthy()
  })

  test('a later forge worktree instance cannot leave a root-session toggle pending', async () => {
    const projectId = uniqueProjectId()
    const dataDir = join(testDir, 'memory')
    const projectRoot = join(testDir, 'root')
    const worktreeDir = join(dataDir, 'worktrees', 'loop-2')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(worktreeDir, { recursive: true })
    const config: PluginConfig = { dataDir, sandbox: { mode: 'msb', enabled: false } }

    await buildCore({
      config,
      projectId,
      directory: projectRoot,
      projectRoot,
      makeClient: (id) => sessionResolvingClient(projectRoot, id),
    })
    await buildCore({
      config,
      projectId,
      directory: worktreeDir,
      projectRoot,
      makeClient: (id) => nonResolvingClient(id),
    })

    const writerDb = initializeDatabase(dataDir)
    createSessionSandboxPreferencesRepo(writerDb).setDesired(projectId, {
      version: 1,
      revision: 'r-root-after-worktree',
      enabled: true,
      sessionId: 'ses-root',
      requestedAt: Date.now(),
    })
    closeDatabase(writerDb)

    await sleep(1200)

    const readerDb = initializeDatabase(dataDir)
    const applied = createSessionSandboxPreferencesRepo(readerDb).getApplied(projectId)
    closeDatabase(readerDb)
    expect(applied?.revision).toBe('r-root-after-worktree')
    expect(applied?.error).toBeTruthy()
  })

  test('after the creating instance is disposed, a survivor processes a new desired revision without closed-db callback failure', async () => {
    const projectId = uniqueProjectId()
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      sandbox: { mode: 'msb', enabled: false },
    }

    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(projectId, {
      version: 1,
      revision: 'r1',
      enabled: true,
      sessionId: 'ses-1',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const first = await buildCore({ config, projectId, makeClient: (id) => nonResolvingClient(id) })
    const survivor = await buildCore({
      config,
      projectId,
      makeClient: (id) => sessionResolvingClient(testDir, id),
    })

    await expect(globBefore(survivor.core, 'ses-1', 'c1')).rejects.toThrow(/unavailable/)

    await first.core.cleanup()

    const writerDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(writerDb).setDesired(projectId, {
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
      const row = createSessionSandboxPreferencesRepo(pollDb).getApplied(projectId)
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
    const projectId = uniqueProjectId()
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      sandbox: { mode: 'msb', enabled: false },
    }

    // Persist a desired ON for a selected session. Sandbox routing is unavailable (disabled), so
    // startup reconciliation must still create a controller that acknowledges the request as
    // OFF-with-error at the matching revision and blocks the selected session fail-closed.
    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(projectId, {
      version: 1,
      revision: 'r-unavail',
      enabled: true,
      sessionId: 'ses-selected',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const built = await buildCore({
      config,
      projectId,
      makeClient: (id) => sessionResolvingClient(testDir, id),
    })

    await expect(globBefore(built.core, 'ses-selected', 'c1')).rejects.toThrow(/unavailable/)

    // The unavailable runtime acknowledged the requested ON at the matching revision as OFF with an
    // error, so the TUI sees a definitive server answer rather than a silent host fallback.
    const db = initializeDatabase(config.dataDir!)
    const applied = createSessionSandboxPreferencesRepo(db).getApplied(projectId)
    expect(applied).not.toBeNull()
    expect(applied!.revision).toBe('r-unavail')
    expect(applied!.enabled).toBe(false)
    expect(applied!.error).toBeTruthy()
    closeDatabase(db)

    // An unrelated host session is unaffected and falls through to the host shell.
    await expect(globBefore(built.core, 'ses-unrelated', 'c2')).resolves.toBeUndefined()

    await built.core.cleanup()
  })

  test('manager initialization failure still acknowledges a requested ON as OFF-with-error', async () => {
    const projectId = uniqueProjectId()
    const config: PluginConfig = {
      dataDir: join(testDir, 'memory'),
      // Sandbox routing is disabled so the deterministic unavailable manager is used (ensureRunning
      // fails closed, stop is a no-op). This makes the OFF-with-error acknowledgement independent of
      // whether the `msb` CLI is installed on the host, exercising the same fail-closed surface as a
      // manager that fails to initialize.
      sandbox: { mode: 'msb', enabled: false },
    }

    const setupDb = initializeDatabase(config.dataDir!)
    createSessionSandboxPreferencesRepo(setupDb).setDesired(projectId, {
      version: 1,
      revision: 'r-manager-fail',
      enabled: true,
      sessionId: 'ses-selected',
      requestedAt: Date.now(),
    })
    closeDatabase(setupDb)

    const built = await buildCore({
      config,
      projectId,
      makeClient: (id) => sessionResolvingClient(testDir, id),
    })

    await expect(globBefore(built.core, 'ses-selected', 'c1')).rejects.toThrow(/unavailable/)

    // Regardless of how the manager became unavailable, the requested ON is acknowledged as
    // OFF-with-error at the matching revision (fail closed).
    const db = initializeDatabase(config.dataDir!)
    const applied = createSessionSandboxPreferencesRepo(db).getApplied(projectId)
    expect(applied).not.toBeNull()
    expect(applied!.revision).toBe('r-manager-fail')
    expect(applied!.enabled).toBe(false)
    expect(applied!.error).toBeTruthy()
    closeDatabase(db)

    await built.core.cleanup()
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
        mode: 'msb',
        image: 'custom-image:latest',
      },
    }

    expect(config.sandbox?.mode).toBe('msb')
  })

  test('Accepts sandbox.enabled flag for opting out of Docker', () => {
    const enabledConfig: PluginConfig = {
      sandbox: { mode: 'msb', enabled: true },
    }
    const disabledConfig: PluginConfig = {
      sandbox: { mode: 'msb', enabled: false },
    }

    expect(enabledConfig.sandbox?.enabled).toBe(true)
    expect(disabledConfig.sandbox?.enabled).toBe(false)
  })
})
