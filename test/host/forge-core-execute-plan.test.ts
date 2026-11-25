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
          data: { sessionId: 'ses_loop', loopName: 'loop-a', worktreeDir: '/wt', workspaceId: 'ws-1', worktreeBranch: 'pm-61-export' },
        }
      },
    }),
  }
})

import { createForgeCore, type ForgeCore } from '../../src/host/forge-core'
import { sandboxSecretProviders } from '../../src/sandbox/secrets'
import type { PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'

const TEST_ROOT = join('/tmp', `forge-core-execute-plan-${Date.now()}`)
const PROVIDER_ID = 'execute-plan-provider'

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
    sandboxSecretProviders().delete(PROVIDER_ID)
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

    expect(result).toEqual({ sessionId: 'ses_loop', loopName: 'loop-a', branch: 'pm-61-export', worktreeDir: '/wt', workspaceId: 'ws-1' })
    const command = dispatched.at(-1) as Record<string, unknown>
    expect(command.type).toBe('loop.start')
    expect(command.maxIterations).toBe(3)
    expect(command.sandbox).toEqual({ enabled: false, resources: { memory: '2g', cpus: '2' } })
  })

  test('rejects sandbox secrets outside loop mode without dispatching', async () => {
    const built = await buildCore()

    await expect(built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'execute-here',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      sandbox: { secrets: [{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }] },
    })).resolves.toEqual({ error: 'Sandbox secrets are only supported for loop executions' })

    await expect(built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'new-session',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      sandbox: { secrets: [{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }] },
    })).resolves.toEqual({ error: 'Sandbox secrets are only supported for loop executions' })

    expect(dispatched).toHaveLength(0)
  })

  test('rejects sandbox secrets when the loop is not sandboxed', async () => {
    const disabledByConfig = await buildCore({ sandbox: { enabled: false } })

    await expect(disabledByConfig.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'loop',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      sandbox: { secrets: [{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }] },
    })).resolves.toEqual({ error: 'Sandbox secrets require a sandboxed loop' })
    expect(dispatched).toHaveLength(0)

    const disabledByRequest = await buildCore()
    await expect(disabledByRequest.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'loop',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      sandbox: { enabled: false, secrets: [{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }] },
    })).resolves.toEqual({ error: 'Sandbox secrets require a sandboxed loop' })
    expect(dispatched).toHaveLength(0)
  })

  test('rejects invalid sandbox secret definitions before dispatching', async () => {
    const built = await buildCore()

    await expect(built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'loop',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      sandbox: { secrets: [{ env: 'LOOP_TOKEN', hosts: [] }] },
    })).resolves.toEqual({ error: 'Invalid sandbox secret LOOP_TOKEN: no allowed hosts' })

    await expect(built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'loop',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      sandbox: {
        secrets: [
          { env: 'LOOP_TOKEN', hosts: ['api.example.com'] },
          { env: 'LOOP_TOKEN', hosts: ['other.example.com'] },
        ],
      },
    })).resolves.toEqual({ error: 'Duplicate sandbox secret LOOP_TOKEN' })

    expect(dispatched).toHaveLength(0)
  })

  test('forwards loop sandbox secrets and their provider into the start-loop command', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => ({ LOOP_TOKEN: 'value' }))
    const built = await buildCore()

    const result = await built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'loop',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      sandbox: {
        secrets: [{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }],
        secretProvider: PROVIDER_ID,
      },
    })

    expect(result).toMatchObject({ sessionId: 'ses_loop', loopName: 'loop-a' })
    const command = dispatched.at(-1) as Record<string, unknown>
    expect(command.type).toBe('loop.start')
    expect(command.sandbox).toEqual({
      secrets: [{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }],
      secretProvider: PROVIDER_ID,
    })
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
    expect(command.branch).toBeUndefined()
    expect(command.baseRef).toBeUndefined()
  })

  test('trims an explicit branch and baseRef into the start-loop command and reports the branch', async () => {
    const built = await buildCore()

    const result = await built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'loop',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      branch: '  pm-61-export  ',
      baseRef: '  origin/pm-61-export  ',
    })

    const command = dispatched.at(-1) as Record<string, unknown>
    expect(command.type).toBe('loop.start')
    expect(command.branch).toBe('pm-61-export')
    expect(command.baseRef).toBe('origin/pm-61-export')
    expect(result).toMatchObject({ branch: 'pm-61-export' })
  })

  test('forwards every loop agent and post-action field into the start-loop command', async () => {
    const built = await buildCore()

    await built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'loop',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      executionAgent: '  my-coder  ',
      auditorAgent: ' my-auditor ',
      postActionAgent: '  my-post ',
      postActionModel: 'prov/post',
      postActionVariant: 'fast',
    })

    const command = dispatched.at(-1) as Record<string, unknown>
    expect(command.type).toBe('loop.start')
    expect(command.executionAgent).toBe('my-coder')
    expect(command.auditorAgent).toBe('my-auditor')
    expect(command.postActionAgent).toBe('my-post')
    expect(command.postActionModel).toBe('prov/post')
    expect(command.postActionVariant).toBe('fast')
  })

  test('forwards executionAgent into new-session and execute-here commands', async () => {
    const built = await buildCore()

    await built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'new-session',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      executionAgent: '  my-coder  ',
    })
    expect((dispatched.at(-1) as Record<string, unknown>).executionAgent).toBe('my-coder')

    await built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'execute-here',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      executionAgent: 'other-coder',
    })
    expect((dispatched.at(-1) as Record<string, unknown>).executionAgent).toBe('other-coder')
  })

  test('ignores branch and baseRef outside loop mode', async () => {
    const built = await buildCore()

    await built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'new-session',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      branch: 'pm-61-export',
      baseRef: 'origin/pm-61-export',
    })
    const newSession = dispatched.at(-1) as Record<string, unknown>
    expect(newSession.type).toBe('plan.execute.newSession')
    expect(newSession).not.toHaveProperty('branch')
    expect(newSession).not.toHaveProperty('baseRef')

    await built.executeTuiPlan({
      sessionId: 'ses_host_1',
      mode: 'execute-here',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      branch: 'pm-61-export',
      baseRef: 'origin/pm-61-export',
    })
    const executeHere = dispatched.at(-1) as Record<string, unknown>
    expect(executeHere.type).toBe('plan.execute.here')
    expect(executeHere).not.toHaveProperty('branch')
    expect(executeHere).not.toHaveProperty('baseRef')
  })
})
