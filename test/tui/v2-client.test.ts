import { describe, test, expect, vi } from 'vitest'
import type { Plugin } from '@opencode/plugin/tui'
import { FORGE_RPC, readForgeLoopSidebar } from '../../src/host/forge-rpc'
import { createForgeRpcCaller, createV2ForgeProjectClient, describeRpcError, loopsToWorkspacesForRecents } from '../../src/tui/v2-client'
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

type RpcMethod = (...args: unknown[]) => Promise<unknown>

function createClient(overrides: Record<string, RpcMethod> = {}, options: { directory?: string } = {}) {
  const methods = {
    executePlan: vi.fn(async () => ({ sessionId: 'ses_loop', loopName: 'loop-a' })),
    sessionPlan: vi.fn(async () => ({ plan: '# Plan' })),
    loops: vi.fn(async () => ({ loops: [] })),
    loopRestart: vi.fn(async () => ({ sessionId: 'ses_restart' })),
    ...overrides,
  }
  const rpc = vi.fn(() => methods)
  const navigate = vi.fn()
  const context = {
    client: {
      rpc,
      provider: { list: vi.fn(async () => ({ data: [] })) },
      model: {
        list: vi.fn(async () => ({ data: [] })),
        default: vi.fn(async () => { throw new Error('no default model') }),
      },
    },
    data: { session: { list: () => [] } },
    ui: { router: { navigate } },
  } as unknown as Plugin.Context
  const client = createV2ForgeProjectClient(context, {
    projectId: 'proj-1',
    directory: options.directory ?? '/work/project',
    onDefaultModel: () => {},
  })
  return { client, rpc, methods, navigate }
}

describe('createV2ForgeProjectClient', () => {
  test('plan.execute calls the executePlan RPC at the current location and drops empty selections', async () => {
    const executePlan = vi.fn(async () => ({ sessionId: 'ses_loop', loopName: 'loop-a' }))
    const { client, rpc, methods } = createClient({ executePlan })

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
    expect(methods.executePlan).toHaveBeenCalledWith(
      { sessionId: 'ses_host', mode: 'loop', title: 'Ship it', plan: '# Plan', loopName: 'loop-a', executionModel: 'anthropic/claude' },
      { location: { directory: '/work/project' } },
    )
  })

  test('plan.execute turns an RPC failure into a prefixed error result', async () => {
    const { client } = createClient({ executePlan: async () => { throw new Error('rpc.unavailable') } })

    await expect(client.plan.execute('ses_host', { mode: 'new-session', title: 'T', plan: '# Plan' }))
      .resolves.toEqual({ error: 'Plan execution failed: rpc.unavailable' })
  })

  test('loadLatestPlan reads the session plan RPC', async () => {
    const sessionPlan = vi.fn(async () => ({ plan: '# Plan\n## Section 1' }))
    const { client, methods } = createClient({ sessionPlan })

    await expect(client.loadLatestPlan('ses_host')).resolves.toBe('# Plan\n## Section 1')
    expect(methods.sessionPlan).toHaveBeenCalledWith(
      { sessionId: 'ses_host' },
      { location: { directory: '/work/project' } },
    )
  })

  test('loadLatestPlan returns null on an RPC error', async () => {
    const { client } = createClient({ sessionPlan: async () => ({ error: 'rpc.unavailable' }) })

    await expect(client.loadLatestPlan('ses_host')).resolves.toBeNull()
  })

  test('loadLoops returns the loops RPC result', async () => {
    const loops = [loop({ name: 'loop-a' })]
    const loopsRpc = vi.fn(async () => ({ loops }))
    const { client, methods } = createClient({ loops: loopsRpc })

    await expect(client.loadLoops()).resolves.toEqual({ loops })
    expect(methods.loops).toHaveBeenCalledWith({}, { location: { directory: '/work/project' } })
  })

  test('loadLoops surfaces an RPC error', async () => {
    const { client } = createClient({ loops: async () => ({ error: 'rpc.unavailable' }) })

    await expect(client.loadLoops()).resolves.toEqual({ error: 'rpc.unavailable' })
  })

  test('restartLoop returns the restarted session', async () => {
    const loopRestart = vi.fn(async () => ({ sessionId: 'ses_restart' }))
    const { client, methods } = createClient({ loopRestart })

    await expect(client.restartLoop({ loopName: 'loop-a', auditorModel: 'b/audit', auditorVariant: 'high' }))
      .resolves.toEqual({ sessionId: 'ses_restart' })
    expect(methods.loopRestart).toHaveBeenCalledWith(
      { loopName: 'loop-a', auditorModel: 'b/audit', auditorVariant: 'high' },
      { location: { directory: '/work/project' } },
    )
  })

  test('restartLoop throws the RPC error', async () => {
    const { client } = createClient({ loopRestart: async () => ({ error: 'Loop "loop-a" was restarted since it was selected.' }) })

    await expect(client.restartLoop({ loopName: 'loop-a', auditorModel: 'b/audit', auditorVariant: '' }))
      .rejects.toThrow('Loop "loop-a" was restarted since it was selected.')
  })

  test('restartLoop forwards force and expectedStartedAt when provided', async () => {
    const loopRestart = vi.fn(async () => ({ sessionId: 'ses_restart' }))
    const { client, methods } = createClient({ loopRestart })

    await expect(client.restartLoop({
      loopName: 'loop-a',
      auditorModel: 'b/audit',
      auditorVariant: 'high',
      force: false,
      expectedStartedAt: '2026-01-01T00:00:00.000Z',
    })).resolves.toEqual({ sessionId: 'ses_restart' })
    expect(methods.loopRestart).toHaveBeenCalledWith(
      {
        loopName: 'loop-a',
        auditorModel: 'b/audit',
        auditorVariant: 'high',
        force: false,
        expectedStartedAt: '2026-01-01T00:00:00.000Z',
      },
      { location: { directory: '/work/project' } },
    )
  })

  test('loadExecutionContext derives workspaces from the loops RPC', async () => {
    const loops = [loop({ name: 'loop-a', startedAt: '2026-09-01T00:00:00.000Z' })]
    const { client, methods } = createClient({ loops: vi.fn(async () => ({ loops })) })

    const context = await client.loadExecutionContext()

    expect(context.workspaces).toEqual(loopsToWorkspacesForRecents('proj-1', loops))
    expect(methods.loops).toHaveBeenCalledWith({}, { location: { directory: '/work/project' } })
  })

  test('loadExecutionContext falls back to no workspaces on a loops RPC error', async () => {
    const { client } = createClient({ loops: async () => { throw new Error('rpc.unavailable') } })

    await expect(client.loadExecutionContext()).resolves.toMatchObject({ workspaces: [] })
  })

  test('every RPC reports the shared error when no location resolves', async () => {
    const { client, methods } = createClient({}, { directory: '' })

    await expect(client.loadLoops()).resolves.toEqual({ error: 'no Forge location for this TUI' })
    expect(methods.loops).not.toHaveBeenCalled()
  })

  test('selectSession navigates the V2 router', async () => {
    const { client, navigate } = createClient()

    await client.selectSession('ses_loop')

    expect(navigate).toHaveBeenCalledWith({ type: 'session', sessionID: 'ses_loop' })
  })
})

describe('createForgeRpcCaller', () => {
  test('reads the loop sidebar RPC at the resolved location', async () => {
    const loopSidebar = vi.fn(async () => ({
      loops: [{ loopName: 'loop-a', status: 'running', iteration: 1, maxIterations: 5 }],
    }))
    const rpc = vi.fn(() => ({ loopSidebar }))
    const context = { client: { rpc } } as unknown as Plugin.Context
    const call = createForgeRpcCaller(context, () => '/work/project')

    const result = await call(
      (client, location) => client.loopSidebar({ limit: 3 }, location),
      readForgeLoopSidebar,
    )

    expect(result).toEqual({ loops: [{ loopName: 'loop-a', status: 'running', iteration: 1, maxIterations: 5 }] })
    expect(loopSidebar).toHaveBeenCalledWith({ limit: 3 }, { location: { directory: '/work/project' } })
  })

  test('surfaces the message of a plain-object RPC rejection instead of [object Object]', async () => {
    const loopSidebar = vi.fn(async () => { throw { type: 'RpcMethodNotFound', message: 'Unknown method loopSidebar' } })
    const context = { client: { rpc: vi.fn(() => ({ loopSidebar })) } } as unknown as Plugin.Context
    const call = createForgeRpcCaller(context, () => '/work/project')

    const result = await call(
      (client, location) => client.loopSidebar({ limit: 3 }, location),
      readForgeLoopSidebar,
    )

    expect(result).toEqual({ error: 'Unknown method loopSidebar (RpcMethodNotFound)' })
  })
})

describe('describeRpcError', () => {
  test('reads Error, typed plain objects, and falls back to String', () => {
    expect(describeRpcError(new Error('boom'))).toBe('boom')
    expect(describeRpcError({ type: 'Invalid', message: 'bad output' })).toBe('bad output (Invalid)')
    expect(describeRpcError({ message: 'bad output' })).toBe('bad output')
    expect(describeRpcError({ type: 'Invalid' })).toBe('Invalid')
    expect(describeRpcError('plain')).toBe('plain')
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
