import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createForgePlugin } from '../src/index'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PluginConfig } from '../src/types'
import type { PluginInput } from '@opencode-ai/plugin'
import { initializeDatabase, closeDatabase, createLoopsRepo, createPlansRepo, createFeatureGroupsRepo } from '../src/storage'

const TEST_DIR = '/tmp/opencode-manager-memory-test-' + Date.now()

const TEST_PROJECT_ID = 'test-proj-id-' + Date.now()

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
    expect(hooks.tool?.['plan-edit']).toBeUndefined()
    expect(hooks.tool?.['plan-write']).toBeUndefined()
    expect(hooks.tool?.['review-read']).toBeDefined()
    expect(hooks.tool?.['review-write']).toBeDefined()
    // Ast-grep tools should NOT be registered
    expect(hooks.tool?.['ast-grep-search']).toBeUndefined()
    expect(hooks.tool?.['ast-grep-scan']).toBeUndefined()
    // Loop tools should be registered
    expect(hooks.tool?.['execute-plan']).toBeDefined()
    expect(hooks.tool?.['loop-cancel']).toBeDefined()
    expect(hooks.tool?.['loop-status']).toBeDefined()
  })

  test('Plugin does NOT register shadow glob or grep tools', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      sandbox: {
        mode: 'docker',
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
      sandbox: { mode: 'docker', enabled: false },
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
        mode: 'docker',
        image: 'custom-image:latest',
      },
    }

    expect(config.sandbox?.mode).toBe('docker')
  })

  test('Accepts sandbox.enabled flag for opting out of Docker', () => {
    const enabledConfig: PluginConfig = {
      sandbox: { mode: 'docker', enabled: true },
    }
    const disabledConfig: PluginConfig = {
      sandbox: { mode: 'docker', enabled: false },
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
    expect(text).toContain('READ-ONLY mode')
    // New explicit rules
    expect(text).toContain('exactly one')
    expect(text).toContain('## Phase')
    expect(text).toContain('Do not insert')
    expect(text).toContain('### Files')
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
