import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { V2_EVENT_TYPES } from '../../src/host/v2-events'
import { createFakeV2Context } from '../helpers/fake-v2-context'
import { useTempConfigHome } from '../helpers/temp-config'
import pluginModule from '../../src/index'

const coreEvents = vi.hoisted(() => ({
  received: [] as Array<{ event: { type: string; properties: Record<string, unknown> } }>,
}))

vi.mock('../../src/host/forge-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/forge-core')>()
  return {
    ...actual,
    createForgeCore: async (
      config: Parameters<typeof actual.createForgeCore>[0],
      host: Parameters<typeof actual.createForgeCore>[1],
    ) => {
      const core = await actual.createForgeCore(config, host)
      const onEvent = core.onEvent.bind(core)
      core.onEvent = async (input) => {
        coreEvents.received.push(input as (typeof coreEvents.received)[number])
        await onEvent(input)
      }
      return core
    },
  }
})

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

describe('V2 server setup', () => {
  useTempConfigHome('forge-v2-setup')
  const dataHomes: string[] = []
  let cleanup: (() => Promise<void>) | null = null
  let subscriptionSignal: AbortSignal | undefined

  beforeEach(() => {
    coreEvents.received.length = 0
    subscriptionSignal = undefined
    const dataHome = mkdtempSync(join(tmpdir(), 'forge-v2-setup-data-'))
    dataHomes.push(dataHome)
    process.env['XDG_DATA_HOME'] = dataHome
  })

  afterEach(async () => {
    await cleanup?.()
    cleanup = null
    delete process.env['XDG_DATA_HOME']
    for (const dir of dataHomes.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('default export carries the V1 server and the V2 setup', () => {
    expect(pluginModule.id).toBe('oc-forge')
    expect(typeof pluginModule.server).toBe('function')
    expect(typeof pluginModule.setup).toBe('function')
  })

  test('setup registers the Forge tools, agents, commands, and hooks', async () => {
    const fake = createFakeV2Context()

    cleanup = await pluginModule.setup(fake.ctx)

    expect(fake.calls.filter((call) => call.method === 'tool.transform')).toHaveLength(1)
    expect(fake.tools.map((tool) => tool.name)).toContain('plan-read')
    expect(fake.calls.filter((call) => call.method === 'agent.transform')).toHaveLength(1)
    expect(fake.agents.map((agent) => agent.id)).toContain('auditor')
    expect(fake.calls.filter((call) => call.method === 'command.transform')).toHaveLength(1)
    expect(fake.commands.map((command) => command.name)).toContain('review')
    expect(fake.hooks.map((hook) => `${hook.domain}.${hook.event}`)).toEqual(
      expect.arrayContaining([
        'tool.execute.before',
        'tool.execute.after',
        'shell.create.before',
        'session.prompt',
        'session.context',
        'session.compaction',
      ]),
    )
  })

  test('the event pump forwards a session.idle event to the core', async () => {
    const fake = createFakeV2Context({
      event: {
        subscribe: (options?: { signal?: AbortSignal }) => {
          subscriptionSignal = options?.signal
          return (async function* () {
            yield { id: 'evt_idle', type: V2_EVENT_TYPES.sessionIdle, data: { sessionID: 'ses_idle' } }
          })()
        },
      },
    })

    cleanup = await pluginModule.setup(fake.ctx)
    await waitFor(() => coreEvents.received.length > 0)

    expect(coreEvents.received).toContainEqual({
      event: { type: V2_EVENT_TYPES.sessionIdle, properties: { sessionID: 'ses_idle' } },
    })

    expect(subscriptionSignal?.aborted).toBe(false)
    await cleanup()
    cleanup = null
    expect(subscriptionSignal?.aborted).toBe(true)
  })

  test('location.shutdown cleans the core up through the event pump', async () => {
    const baselineSigint = process.listenerCount('SIGINT')
    const fake = createFakeV2Context({
      event: {
        subscribe: () =>
          (async function* () {
            yield { id: 'evt_shutdown', type: V2_EVENT_TYPES.locationShutdown, data: {} }
          })(),
      },
    })

    cleanup = await pluginModule.setup(fake.ctx)
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(baselineSigint)

    await waitFor(() => process.listenerCount('SIGINT') === baselineSigint)
  })
})
