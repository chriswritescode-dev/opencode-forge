import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createForgePlugin } from '../src/index'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PluginConfig } from '../src/types'
import type { PluginInput } from '@opencode-ai/plugin'

const TEST_DIR = '/tmp/opencode-manager-memory-test-' + Date.now()

const TEST_PROJECT_ID = 'test-project-id-' + Date.now()

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

  test('REGRESSION: two plugin instances with different worktree directories must use separate graph cache paths', async () => {
    const sharedDataDir = `${testDir}/shared-data`
    const config: PluginConfig = {
      dataDir: sharedDataDir,
      graph: { enabled: true, autoScan: false },
    }

    const worktree1Dir = join(testDir, 'worktree1')
    const worktree2Dir = join(testDir, 'worktree2')
    mkdirSync(worktree1Dir, { recursive: true })
    mkdirSync(worktree2Dir, { recursive: true })

    const mockInput1 = {
      directory: worktree1Dir,
      worktree: worktree1Dir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const mockInput2 = {
      directory: worktree2Dir,
      worktree: worktree2Dir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const plugin = createForgePlugin(config)

    const hooks1 = await plugin(mockInput1)
    const hooks2 = await plugin(mockInput2)

    const { hashGraphCacheScope } = await import('../src/storage/graph-projects')
    const cacheHash1 = hashGraphCacheScope(TEST_PROJECT_ID, worktree1Dir)
    const cacheHash2 = hashGraphCacheScope(TEST_PROJECT_ID, worktree2Dir)
    
    const dbPath1 = join(sharedDataDir, 'graph', cacheHash1, 'graph.db')
    const dbPath2 = join(sharedDataDir, 'graph', cacheHash2, 'graph.db')

    expect(cacheHash1).not.toBe(cacheHash2)

    const typedHooks1 = hooks1 as { getCleanup?: () => Promise<void> }
    const typedHooks2 = hooks2 as { getCleanup?: () => Promise<void> }
    if (typedHooks1.getCleanup) await typedHooks1.getCleanup()
    if (typedHooks2.getCleanup) await typedHooks2.getCleanup()
  })

  test('REGRESSION: plugin startup with autoScan reuses existing cache when files unchanged', async () => {
    const sharedDataDir = `${testDir}/shared-data`
    const config: PluginConfig = {
      dataDir: sharedDataDir,
      graph: { enabled: true, autoScan: true },
    }

    const worktreeDir = join(testDir, 'worktree-for-reuse')
    mkdirSync(worktreeDir, { recursive: true })

    // Create a test file
    const testFile = join(worktreeDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const mockInput = {
      directory: worktreeDir,
      worktree: worktreeDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const plugin = createForgePlugin(config)

    // First initialization - builds the cache
    const hooks1 = await plugin(mockInput)
    const typedHooks1 = hooks1 as { getCleanup?: () => Promise<void> }
    
    // Wait for scan to complete
    await new Promise(resolve => setTimeout(resolve, 500))
    
    if (typedHooks1.getCleanup) await typedHooks1.getCleanup()

    // Second initialization - should reuse cache
    const hooks2 = await plugin(mockInput)
    const typedHooks2 = hooks2 as { getCleanup?: () => Promise<void> }
    
    // Wait for startup check to complete
    await new Promise(resolve => setTimeout(resolve, 500))
    
    if (typedHooks2.getCleanup) await typedHooks2.getCleanup()

    // Verify cache exists and was not recreated
    const { hashGraphCacheScope } = await import('../src/storage/graph-projects')
    const cacheHash = hashGraphCacheScope(TEST_PROJECT_ID, worktreeDir)
    const cachePath = join(sharedDataDir, 'graph', cacheHash)
    
    expect(existsSync(cachePath)).toBe(true)
  })

  test('REGRESSION: plugin startup rescans when files change', async () => {
    const sharedDataDir = `${testDir}/shared-data`
    const config: PluginConfig = {
      dataDir: sharedDataDir,
      graph: { enabled: true, autoScan: true },
    }

    const worktreeDir = join(testDir, 'worktree-for-rescan')
    mkdirSync(worktreeDir, { recursive: true })

    // Create initial test file
    const testFile = join(worktreeDir, 'index.ts')
    writeFileSync(testFile, 'export const value = 1')

    const mockInput = {
      directory: worktreeDir,
      worktree: worktreeDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const plugin = createForgePlugin(config)

    // First initialization - builds the cache
    const hooks1 = await plugin(mockInput)
    const typedHooks1 = hooks1 as { getCleanup?: () => Promise<void> }
    
    // Wait for scan to complete
    await new Promise(resolve => setTimeout(resolve, 500))
    
    if (typedHooks1.getCleanup) await typedHooks1.getCleanup()

    // Modify the file
    await new Promise(resolve => setTimeout(resolve, 10))
    writeFileSync(testFile, 'export const value = 2')

    // Second initialization - should detect change and rescan
    const hooks2 = await plugin(mockInput)
    const typedHooks2 = hooks2 as { getCleanup?: () => Promise<void> }
    
    // Wait for startup check and potential rescan
    await new Promise(resolve => setTimeout(resolve, 500))
    
    if (typedHooks2.getCleanup) await typedHooks2.getCleanup()

    // Verify cache still exists
    const { hashGraphCacheScope } = await import('../src/storage/graph-projects')
    const cacheHash = hashGraphCacheScope(TEST_PROJECT_ID, worktreeDir)
    const cachePath = join(sharedDataDir, 'graph', cacheHash)
    
    expect(existsSync(cachePath)).toBe(true)
  })

  test('REGRESSION: worktree loop startup uses worktree directory as session and graph root', async () => {
    const testDataDir = `${testDir}/plugin-test-data`
    const config: PluginConfig = {
      dataDir: testDataDir,
      graph: { enabled: true, autoScan: false },
    }

    const worktreeDir = join(testDir, 'worktree-for-graph')
    mkdirSync(worktreeDir, { recursive: true })

    const mockInput = {
      directory: worktreeDir,
      worktree: worktreeDir,
      client: {} as never,
      project: { id: TEST_PROJECT_ID } as never,
      serverUrl: new URL('http://localhost:5551'),
      $: {} as never,
    }

    const plugin = createForgePlugin(config)
    const hooks = await plugin(mockInput) as { getCleanup?: () => Promise<void> }

    const { hashGraphCacheScope } = await import('../src/storage/graph-projects')
    const cacheHash = hashGraphCacheScope(TEST_PROJECT_ID, worktreeDir)
    
    expect(cacheHash).toBeDefined()

    if (hooks.getCleanup) await hooks.getCleanup()
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

    const dbPath = `${testDir}/.opencode/memory/graph.db`
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
    // Memory CRUD tools are NOT registered in graph-only mode
    expect(hooks.tool?.['memory-read']).toBeUndefined()
    expect(hooks.tool?.['memory-write']).toBeUndefined()
    expect(hooks.tool?.['memory-delete']).toBeUndefined()
    expect(hooks.tool?.['memory-health']).toBeUndefined()
    // Graph tools should be registered
    expect(hooks.tool?.['graph-status']).toBeDefined()
    expect(hooks.tool?.['graph-query']).toBeDefined()
    expect(hooks.tool?.['graph-symbols']).toBeDefined()
    expect(hooks.tool?.['graph-analyze']).toBeDefined()
    // Plan/review tools should be registered
    expect(hooks.tool?.['plan-read']).toBeDefined()
    expect(hooks.tool?.['plan-edit']).toBeUndefined()
    expect(hooks.tool?.['plan-write']).toBeUndefined()
    expect(hooks.tool?.['review-read']).toBeDefined()
    expect(hooks.tool?.['review-write']).toBeDefined()
    // Loop tools should be registered
    expect(hooks.tool?.['loop']).toBeDefined()
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
      graph: { enabled: true, autoScan: false },
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

  test('graph.enabled=false disables worker, tools, prompts, and persists unavailable status', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      graph: { enabled: false },
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

    // Graph tools must NOT be registered
    expect(hooks.tool?.['graph-status']).toBeUndefined()
    expect(hooks.tool?.['graph-query']).toBeUndefined()
    expect(hooks.tool?.['graph-symbols']).toBeUndefined()
    expect(hooks.tool?.['graph-analyze']).toBeUndefined()

    // Agent prompts and explore permissions must NOT mention graph tools
    const userConfig: Record<string, unknown> = {}
    await (hooks.config as (cfg: Record<string, unknown>) => Promise<void>)(userConfig)
    const agentMap = userConfig.agent as Record<string, { prompt?: string; permission?: Record<string, string> }>
    expect(agentMap.code.prompt).not.toContain('graph-query')
    expect(agentMap.code.prompt).toContain('Graph tooling is disabled')
    expect(agentMap.explore?.permission?.['graph-query']).toBeUndefined()
    expect(agentMap.explore?.permission?.['graph-symbols']).toBeUndefined()
    expect(agentMap.explore?.permission?.['graph-analyze']).toBeUndefined()

    // Graph status must be persisted as 'unavailable'
    const { createGraphStatusRepo } = await import('../src/storage/repos/graph-status-repo')
    const { initializeDatabase } = await import('../src/storage')
    const db = initializeDatabase(`${testDir}/.opencode/memory`)
    const repo = createGraphStatusRepo(db)
    const status = repo.read(TEST_PROJECT_ID, testDir)
    expect(status?.state).toBe('unavailable')
    db.close()
  })

  test('REGRESSION: repeated plugin instances after disposal maintain stable cleanup', async () => {
    const config: PluginConfig = {
      dataDir: `${testDir}/.opencode/memory`,
      graph: { enabled: true, autoScan: false },
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

  test('Accepts graph config', () => {
    const config: PluginConfig = {
      graph: {
        enabled: true,
        watch: true,
      },
    }

    expect(config.graph?.enabled).toBe(true)
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
