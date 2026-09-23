import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { createForgeCore, type ForgeCore } from '../../src/host/forge-core'
import { createFakeForgeClient, type RecordedCall } from '../helpers/fake-client'
import { SHIM_ENV_CONTAINER } from '../../src/sandbox/shell-shim'

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

  async function buildCore(): Promise<{ core: ForgeCore; calls: RecordedCall[] }> {
    const projectId = `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { client, calls } = createFakeForgeClient({
      session: {
        get: async () => ({ id: 'ses_host_1', projectID: projectId, directory: testDir, parentID: null }),
      },
    })
    core = await createForgeCore(
      { dataDir: join(testDir, 'memory') },
      { directory: testDir, projectId, projectRoot: testDir, client },
    )
    return { core, calls }
  }

  test('shellEnv for a session outside any loop writes no sandbox container', async () => {
    const built = await buildCore()

    const output = { env: {} as Record<string, string> }
    await built.core.shellEnv({ cwd: testDir, sessionID: 'ses_host_1' }, output)

    expect(built.calls.some((call) => call.method === 'session.get')).toBe(true)
    expect(output.env[SHIM_ENV_CONTAINER]).toBeUndefined()
  })

  test('applyConfig points the shell at the sandbox shim', async () => {
    const built = await buildCore()

    const shimPath = built.core.shellShimPath
    expect(shimPath).not.toBeNull()
    expect(shimPath !== null && existsSync(shimPath)).toBe(true)

    const cfg: Record<string, unknown> = {}
    await built.core.applyConfig(cfg)

    expect(cfg.shell).toBe(shimPath)
  })
})
