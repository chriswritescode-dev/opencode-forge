import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { createForgeCore, type ForgeCore } from '../../src/host/forge-core'
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

  async function buildCore(): Promise<{ core: ForgeCore; calls: RecordedCall[]; adapters: unknown[] }> {
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
    return { core, calls, adapters }
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
})
