import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { createForgeCore, type ForgeCore } from '../../src/host/forge-core'
import { closeDatabase, createSessionAutoApproveRepo, initializeDatabase } from '../../src/storage'
import { resolveSessionAutoApproveFlag } from '../../src/utils/session-auto-approve-flag'
import { createFakeForgeClient, type RecordedCall } from '../helpers/fake-client'

const TEST_ROOT = join('/tmp', `forge-core-test-${Date.now()}`)

describe('createForgeCore', () => {
  let testDir: string
  let core: ForgeCore | null

  beforeEach(() => {
    testDir = join(TEST_ROOT, Math.random().toString(36).slice(2))
    mkdirSync(testDir, { recursive: true })
    core = null
  })

  afterEach(async () => {
    await core?.cleanup()
    core = null
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  async function buildCore(): Promise<{ core: ForgeCore; calls: RecordedCall[]; adapters: unknown[]; projectId: string }> {
    const projectId = `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { client, calls } = createFakeForgeClient({
      session: {
        get: async () => ({ id: 'ses_host_1', projectID: projectId, directory: testDir, parentID: null }),
      },
    })
    const adapters: unknown[] = []
    core = await createForgeCore(
      { dataDir: join(testDir, 'memory') },
      { directory: testDir, projectId, projectRoot: testDir, client, registerWorkspaceAdapter: (adapter) => adapters.push(adapter) },
    )
    return { core, calls, adapters, projectId }
  }

  test('registers the forge workspace adapter and writes the sandbox shim', async () => {
    const built = await buildCore()

    expect(built.adapters).toHaveLength(1)
    const shimPath = built.core.shellShimPath
    expect(shimPath).not.toBeNull()
    expect(shimPath !== null && existsSync(shimPath)).toBe(true)
  })

  test('resolveShellSandbox skips session lookups while no loop or host sandbox is active', async () => {
    const built = await buildCore()

    await expect(built.core.resolveShellSandbox('ses_host_1')).resolves.toBeNull()
    expect(built.calls.some((call) => call.method === 'session.get')).toBe(false)
  })

  test('autoApprovesPermissions honors the per-session auto-approve flag', async () => {
    const built = await buildCore()

    const db = initializeDatabase(join(testDir, 'memory'))
    try {
      createSessionAutoApproveRepo(db).enable(built.projectId, 'ses_host_1', Date.now())
    } finally {
      closeDatabase(db)
    }

    await expect(built.core.autoApprovesPermissions('ses_host_1')).resolves.toBe(true)
    await expect(built.core.autoApprovesPermissions('ses_other')).resolves.toBe(false)
  })
})

describe('resolveSessionAutoApproveFlag', () => {
  const enabledSet = (ids: string[]) => (sessionID: string) => ids.includes(sessionID)
  const parents = (map: Record<string, string | null>) => async (sessionID: string) => map[sessionID] ?? null

  test('returns true when the flag is enabled for the session itself', async () => {
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet(['a']),
      getParentId: parents({}),
      isInActiveLoop: async () => false,
    })

    expect(result).toEqual({ enabled: true, flagOwnerId: 'a' })
  })

  test('returns true when the flag is enabled for an ancestor', async () => {
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'c',
      isEnabled: enabledSet(['a']),
      getParentId: parents({ c: 'b', b: 'a' }),
      isInActiveLoop: async () => false,
    })

    expect(result).toEqual({ enabled: true, flagOwnerId: 'a' })
  })

  test('returns false inside an active loop even when the flag is enabled', async () => {
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet(['a']),
      getParentId: parents({}),
      isInActiveLoop: async () => true,
    })

    expect(result).toEqual({ enabled: false })
  })

  test('fails closed when a parent lookup throws', async () => {
    const error = new Error('lookup failed')
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet([]),
      getParentId: async () => {
        throw error
      },
      isInActiveLoop: async () => false,
    })

    expect(result).toEqual({ enabled: false, error })
  })

  test('stops on a cycle instead of looping forever', async () => {
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet([]),
      getParentId: parents({ a: 'b', b: 'a' }),
      isInActiveLoop: async () => false,
    })

    expect(result).toEqual({ enabled: false })
  })

  test('returns false when nothing is enabled', async () => {
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet([]),
      getParentId: parents({ a: 'b', b: null }),
      isInActiveLoop: async () => false,
    })

    expect(result).toEqual({ enabled: false })
  })
})
