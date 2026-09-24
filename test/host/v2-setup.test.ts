import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FORGE_EVENT_TYPES, V2_EVENT_TYPES } from '../../src/host/v2-events'
import { FORGE_RPC } from '../../src/host/forge-rpc'
import type { ForgeClient } from '../../src/client/port'
import { createFakeV2Context } from '../helpers/fake-v2-context'
import { useTempConfigHome } from '../helpers/temp-config'
import pluginModule from '../../src/index'

const coreEvents = vi.hoisted(() => ({
  received: [] as Array<{ directory: string; event: { type: string; properties: Record<string, unknown> } }>,
  clients: [] as unknown[],
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
      coreEvents.clients.push(host.client)
      const onEvent = core.onEvent.bind(core)
      core.onEvent = async (input) => {
        coreEvents.received.push({ directory: host.directory, event: input.event })
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

function receivedFor(directory: string) {
  return coreEvents.received
    .filter((entry) => entry.directory === directory)
    .map((entry) => entry.event)
}

function lastClient(): ForgeClient {
  return coreEvents.clients[coreEvents.clients.length - 1] as ForgeClient
}

interface V2EventStreamSubscriber {
  queue: unknown[]
  wake: (() => void) | null
  aborted: boolean
}

interface V2EventStream {
  push(event: unknown): void
  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
  signals: AbortSignal[]
}

function createV2EventStream(): V2EventStream {
  const subscribers = new Set<V2EventStreamSubscriber>()
  const signals: AbortSignal[] = []

  return {
    signals,
    push(event) {
      for (const subscriber of subscribers) {
        subscriber.queue.push(event)
        subscriber.wake?.()
      }
    },
    subscribe(options) {
      const subscriber: V2EventStreamSubscriber = { queue: [], wake: null, aborted: false }
      subscribers.add(subscriber)
      if (options?.signal) {
        signals.push(options.signal)
        options.signal.addEventListener('abort', () => {
          subscriber.aborted = true
          subscriber.wake?.()
        }, { once: true })
      }
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<unknown>> => {
            while (subscriber.queue.length === 0) {
              if (subscriber.aborted) return { done: true, value: undefined }
              await new Promise<void>((resolve) => {
                subscriber.wake = resolve
              })
              subscriber.wake = null
            }
            return { done: false, value: subscriber.queue.shift() }
          },
          return: async (): Promise<IteratorResult<unknown>> => ({ done: true, value: undefined }),
        }),
      }
    },
  }
}

describe('V2 server setup', () => {
  useTempConfigHome('forge-v2-setup')
  const dataHomes: string[] = []
  const cleanups: Array<() => Promise<void>> = []

  beforeEach(() => {
    coreEvents.received.length = 0
    coreEvents.clients.length = 0
    const dataHome = mkdtempSync(join(tmpdir(), 'forge-v2-setup-data-'))
    dataHomes.push(dataHome)
    process.env['XDG_DATA_HOME'] = dataHome
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => {})
    }
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

    cleanups.push(await pluginModule.setup(fake.ctx))

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

  test('registers FORGE_RPC once and bridges client toasts to the registration emitter', async () => {
    const fake = createFakeV2Context()

    cleanups.push(await pluginModule.setup(fake.ctx))

    const registerCalls = fake.calls.filter((call) => call.method === 'rpc.register')
    expect(registerCalls).toHaveLength(1)
    expect(registerCalls[0]?.args[0]).toBe(FORGE_RPC)

    await lastClient().tui.publish({
      directory: '/tmp/forge-project',
      body: {
        type: 'tui.toast.show',
        properties: { title: 'Loop done', message: 'All sections passed', variant: 'success', duration: 4000 },
      },
    })

    expect(fake.rpc.emitted).toEqual([{
      event: 'toast',
      data: {
        projectId: 'proj_fake',
        title: 'Loop done',
        message: 'All sections passed',
        variant: 'success',
        duration: 4000,
      },
    }])
  })

  test('a registration failure does not reject setup and drops toasts', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = createFakeV2Context({
      rpc: { register: vi.fn().mockRejectedValue(new Error('rpc unavailable')) },
    })

    cleanups.push(await pluginModule.setup(fake.ctx))

    expect(errorSpy).toHaveBeenCalledWith('[forge] failed to register toast RPC', expect.any(Error))
    errorSpy.mockRestore()

    await expect(lastClient().tui.publish({
      directory: '/tmp/forge-project',
      body: { type: 'tui.toast.show', properties: { message: 'Dropped', variant: 'warning' } },
    })).resolves.toBeUndefined()
    expect(fake.rpc.emitted).toEqual([])
  })

  test('cleanup disposes the RPC registration once', async () => {
    const fake = createFakeV2Context()

    const cleanup = await pluginModule.setup(fake.ctx)
    await cleanup()
    await cleanup()

    expect(fake.rpc.disposed).toBe(1)
  })

  test('the event pump forwards a session.execution.succeeded as an idle session.status and idle', async () => {
    const stream = createV2EventStream()
    const fake = createFakeV2Context({
      location: { directory: '/project-a' },
      event: { subscribe: stream.subscribe },
    })

    cleanups.push(await pluginModule.setup(fake.ctx))
    stream.push({ id: 'evt_succeeded', type: V2_EVENT_TYPES.sessionExecutionSucceeded, data: { sessionID: 'ses_succeeded' } })
    await waitFor(() => receivedFor('/project-a').length >= 2)

    expect(receivedFor('/project-a')).toEqual([
      {
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: { sessionID: 'ses_succeeded', status: { type: 'idle' } },
      },
      { type: FORGE_EVENT_TYPES.sessionIdle, properties: { sessionID: 'ses_succeeded' } },
    ])

    expect(stream.signals[0]?.aborted).toBe(false)
    await cleanups.pop()!()
    expect(stream.signals[0]?.aborted).toBe(true)
  })

  test('the event pump forwards a session.execution.started as a busy session.status', async () => {
    const stream = createV2EventStream()
    const fake = createFakeV2Context({
      location: { directory: '/project-a' },
      event: { subscribe: stream.subscribe },
    })

    cleanups.push(await pluginModule.setup(fake.ctx))
    stream.push({ id: 'evt_started', type: V2_EVENT_TYPES.sessionExecutionStarted, data: { sessionID: 'ses_started' } })
    await waitFor(() => receivedFor('/project-a').length > 0)

    expect(receivedFor('/project-a')).toEqual([
      {
        type: FORGE_EVENT_TYPES.sessionStatus,
        properties: { sessionID: 'ses_started', status: { type: 'busy' } },
      },
    ])
  })

  test('a foreign location shutdown leaves this location running and reusable', async () => {
    const baselineSigint = process.listenerCount('SIGINT')
    const stream = createV2EventStream()
    const a = createFakeV2Context({ location: { directory: '/project-a' }, event: { subscribe: stream.subscribe } })
    const b = createFakeV2Context({ location: { directory: '/project-b' }, event: { subscribe: stream.subscribe } })
    const cleanupA = await pluginModule.setup(a.ctx)
    cleanups.push(cleanupA)
    const cleanupB = await pluginModule.setup(b.ctx)
    cleanups.push(cleanupB)
    expect(process.listenerCount('SIGINT')).toBe(baselineSigint + 2)

    stream.push({ id: 'evt_shutdown_b', type: V2_EVENT_TYPES.locationShutdown, location: { directory: '/project-b' }, data: {} })
    await waitFor(() => process.listenerCount('SIGINT') === baselineSigint + 1)
    expect(stream.signals[0]?.aborted).toBe(false)
    expect(stream.signals[1]?.aborted).toBe(true)

    stream.push({ id: 'evt_after', type: V2_EVENT_TYPES.sessionExecutionSucceeded, data: { sessionID: 'ses-after' } })
    await waitFor(() => receivedFor('/project-a').some((event) => event.properties.sessionID === 'ses-after'))
    expect(receivedFor('/project-b').some((event) => event.properties.sessionID === 'ses-after')).toBe(false)

    const planRead = a.tools.find((tool) => tool.name === 'plan-read')
    const result = await planRead!.execute({}, {
      sessionID: 'ses-a',
      messageID: 'msg-a',
      agent: 'code',
      signal: new AbortController().signal,
    })
    expect(result).toBeDefined()

    await cleanupB()
    await cleanupB()
    await cleanupB()
    expect(process.listenerCount('SIGINT')).toBe(baselineSigint + 1)

    stream.push({ id: 'evt_shutdown_a', type: V2_EVENT_TYPES.locationShutdown, location: { directory: '/project-a' }, data: {} })
    await waitFor(() => process.listenerCount('SIGINT') === baselineSigint)
    expect(stream.signals[0]?.aborted).toBe(true)
  })

  test('a shutdown without a location is ignored by every instance', async () => {
    const baselineSigint = process.listenerCount('SIGINT')
    const stream = createV2EventStream()
    const fake = createFakeV2Context({ location: { directory: '/project-a' }, event: { subscribe: stream.subscribe } })
    cleanups.push(await pluginModule.setup(fake.ctx))

    stream.push({ id: 'evt_shutdown', type: V2_EVENT_TYPES.locationShutdown, data: {} })
    stream.push({ id: 'evt_barrier', type: V2_EVENT_TYPES.sessionExecutionSucceeded, data: { sessionID: 'ses-barrier' } })
    await waitFor(() => receivedFor('/project-a').length > 0)

    expect(process.listenerCount('SIGINT')).toBe(baselineSigint + 1)
    expect(stream.signals[0]?.aborted).toBe(false)
  })
})
