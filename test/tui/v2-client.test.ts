import { describe, test, expect, vi } from 'vitest'
import type { Plugin } from '@opencode/plugin/tui'
import { FORGE_RPC } from '../../src/host/forge-rpc'
import { createV2ForgeProjectClient, loopsToWorkspacesForRecents } from '../../src/tui/v2-client'
import { deriveExecutionPreferencesFromWorkspaces } from '../../src/utils/tui-execution-preferences'
import type { LoopInfo } from '../../src/utils/tui-models'

function loop(overrides: Partial<LoopInfo>): LoopInfo {
  return {
    name: 'loop',
    status: 'completed',
    phase: 'coding',
    iteration: 1,
    maxIterations: 5,
    sessionId: 'ses_loop',
    active: false,
    restartable: true,
    restartRequiresForce: false,
    ...overrides,
  }
}

function createClient(executePlan: (input: unknown, options: unknown) => Promise<unknown>) {
  const rpc = vi.fn(() => ({ executePlan }))
  const navigate = vi.fn()
  const context = {
    client: { rpc },
    ui: { router: { navigate } },
  } as unknown as Plugin.Context
  const client = createV2ForgeProjectClient(context, {
    projectId: 'proj-1',
    directory: '/work/project',
    dbPath: '/nonexistent/forge.db',
    signal: new AbortController().signal,
    onDefaultModel: () => {},
  })
  return { client, rpc, navigate }
}

describe('createV2ForgeProjectClient', () => {
  test('plan.execute calls the executePlan RPC at the current location and drops empty selections', async () => {
    const executePlan = vi.fn(async () => ({ sessionId: 'ses_loop', loopName: 'loop-a' }))
    const { client, rpc } = createClient(executePlan)

    const result = await client.plan.execute('ses_host', {
      mode: 'loop',
      title: 'Ship it',
      plan: '# Plan',
      loopName: 'loop-a',
      executionModel: 'anthropic/claude',
      auditorModel: '',
      targetSessionId: 'ses_host',
    })

    expect(result).toEqual({ sessionId: 'ses_loop', loopName: 'loop-a' })
    expect(rpc).toHaveBeenCalledWith(FORGE_RPC)
    expect(executePlan).toHaveBeenCalledWith(
      { sessionId: 'ses_host', mode: 'loop', title: 'Ship it', plan: '# Plan', loopName: 'loop-a', executionModel: 'anthropic/claude' },
      { location: { directory: '/work/project' } },
    )
  })

  test('plan.execute turns an RPC failure into an error result', async () => {
    const { client } = createClient(async () => { throw new Error('rpc.unavailable') })

    await expect(client.plan.execute('ses_host', { mode: 'new-session', title: 'T', plan: '# Plan' }))
      .resolves.toEqual({ error: 'Plan execution failed: rpc.unavailable' })
  })

  test('selectSession navigates the V2 router', async () => {
    const { client, navigate } = createClient(async () => ({}))

    await client.selectSession('ses_loop')

    expect(navigate).toHaveBeenCalledWith({ type: 'session', sessionID: 'ses_loop' })
  })
})

describe('loopsToWorkspacesForRecents', () => {
  test('the most recently started loop supplies the dialog defaults', () => {
    const workspaces = loopsToWorkspacesForRecents('proj-1', [
      loop({ name: 'old', startedAt: '2026-09-01T00:00:00.000Z', executionModel: 'a/old', auditorModel: 'b/old' }),
      loop({ name: 'new', startedAt: '2026-09-20T00:00:00.000Z', executionModel: 'a/new', auditorModel: 'b/new', auditorVariant: 'high' }),
    ])

    expect(deriveExecutionPreferencesFromWorkspaces('proj-1', workspaces)).toEqual({
      mode: 'Loop',
      executionModel: 'a/new',
      auditorModel: 'b/new',
      executionVariant: undefined,
      auditorVariant: 'high',
    })
  })
})
