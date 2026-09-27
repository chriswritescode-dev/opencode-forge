import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

const dispatched: Array<Record<string, unknown>> = []

vi.mock('../../src/services/execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/execution')>()
  return {
    ...actual,
    createForgeExecutionService: () => ({
      dispatch: async (_ctx: unknown, command: Record<string, unknown>) => {
        dispatched.push(command)
        return {
          ok: true as const,
          data: { sessionId: 'ses_loop', loopName: 'loop-a', worktreeDir: '/wt', workspaceId: 'ws-1' },
        }
      },
    }),
  }
})

import { createForgeCore, type ForgeCore } from '../../src/host/forge-core'
import type { PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'

const TEST_ROOT = join('/tmp', `forge-core-execute-plan-${Date.now()}`)

describe('createForgeCore executeTuiPlan loop settings', () => {
  let testDir: string
  let core: ForgeCore | null

  beforeEach(() => {
    dispatched.length = 0
    testDir = join(TEST_ROOT, Math.random().toString(36).slice(2))
    mkdirSync(testDir, { recursive: true })
    core = null
  })

  afterEach(async () => {
    await core?.cleanup()
    core = null
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  async function buildCore(config: PluginConfig = {}): Promise<ForgeCore> {
    const projectId = `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { client } = createFakeForgeClient({
      session: {
        get: async () => ({ id: 'ses_host_1', projectID: projectId, directory: testDir, parentID: null }),
      },
    })
    core = await createForgeCore(
      { dataDir: join(testDir, 'memory'), ...config },
      {
        directory: testDir,
        projectId,
        projectRoot: testDir,
        client,
        registerWorkspaceAdapter: () => {},
      },
    )
    return core
  }

  test('forwards an explicit maxIterations and a validated sandbox into the start-loop command', async () => {
    const built = await buildCore({ loop: { defaultMaxIterations: 5 } })

    const result = await built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'loop',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      maxIterations: 3,
      sandbox: { enabled: false, resources: { memory: '2g', cpus: '2', dockerDisk: 'bad' } },
    })

    expect(result).toEqual({ sessionId: 'ses_loop', loopName: 'loop-a', worktreeDir: '/wt', workspaceId: 'ws-1' })
    const command = dispatched.at(-1) as Record<string, unknown>
    expect(command.type).toBe('loop.start')
    expect(command.maxIterations).toBe(3)
    expect(command.sandbox).toEqual({ enabled: false, resources: { memory: '2g', cpus: '2' } })
  })

  test('falls back to the configured default max iterations and drops an invalid sandbox', async () => {
    const built = await buildCore({ loop: { defaultMaxIterations: 5 } })

    await built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'loop',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      sandbox: { resources: { memory: 'nonsense' } },
    })

    const command = dispatched.at(-1) as Record<string, unknown>
    expect(command.type).toBe('loop.start')
    expect(command.maxIterations).toBe(5)
    expect(command.sandbox).toBeUndefined()
  })
})
