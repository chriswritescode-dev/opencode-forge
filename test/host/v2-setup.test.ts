import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FORGE_EVENT_TYPES, V2_EVENT_TYPES } from '../../src/host/v2-events'
import { createFakeV2Context } from '../helpers/fake-v2-context'
import { useTempConfigHome } from '../helpers/temp-config'
import pluginModule from '../../src/index'

const coreEvents = vi.hoisted(() => ({
  received: [] as Array<{ directory: string; event: { type: string; properties: Record<string, unknown> } }>,
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

  test('the event pump forwards a session.idle event to the core', async () => {
    const stream = createV2EventStream()
    const fake = createFakeV2Context({
      location: { directory: '/project-a' },
      event: { subscribe: stream.subscribe },
    })

    cleanups.push(await pluginModule.setup(fake.ctx))
    stream.push({ id: 'evt_idle', type: V2_EVENT_TYPES.sessionIdle, data: { sessionID: 'ses_idle' } })
    await waitFor(() => receivedFor('/project-a').length > 0)

    expect(coreEvents.received).toContainEqual({
      directory: '/project-a',
      event: { type: V2_EVENT_TYPES.sessionIdle, properties: { sessionID: 'ses_idle' } },
    })

    expect(stream.signals[0]?.aborted).toBe(false)
    await cleanups.pop()!()
    expect(stream.signals[0]?.aborted).toBe(true)
  })

  test('a located content event reaches only the core of that location', async () => {
    const stream = createV2EventStream()
    const a = createFakeV2Context({
      location: { directory: '/project-a', project: { id: 'proj-a' } },
      event: { subscribe: stream.subscribe },
    })
    const b = createFakeV2Context({
      location: { directory: '/project-b', project: { id: 'proj-b' } },
      event: { subscribe: stream.subscribe },
    })
    cleanups.push(await pluginModule.setup(a.ctx))
    cleanups.push(await pluginModule.setup(b.ctx))

    stream.push({
      id: 'evt_text',
      type: V2_EVENT_TYPES.sessionTextEnded,
      location: { directory: '/project-a' },
      data: { sessionID: 'ses-a', assistantMessageID: 'msg-a', ordinal: 0, text: 'full text' },
    })
    stream.push({ id: 'evt_barrier', type: V2_EVENT_TYPES.sessionIdle, data: { sessionID: 'ses-barrier' } })
    await waitFor(() => receivedFor('/project-b').length > 0)

    expect(receivedFor('/project-a')).toEqual([
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: {
          sessionID: 'ses-a',
          directory: '/project-a',
          part: { sessionID: 'ses-a', messageID: 'msg-a', type: 'text', text: 'full text' },
        },
      },
      { type: V2_EVENT_TYPES.sessionIdle, properties: { sessionID: 'ses-barrier' } },
    ])
    expect(receivedFor('/project-b')).toEqual([
      { type: V2_EVENT_TYPES.sessionIdle, properties: { sessionID: 'ses-barrier' } },
    ])
  })

  test('a content event without a location is admitted by the session owner only', async () => {
    const stream = createV2EventStream()
    const owner = createFakeV2Context({
      location: { directory: '/project-a' },
      event: { subscribe: stream.subscribe },
      session: {
        get: async () => ({ location: { directory: '/project-a' } }),
      },
    })
    const foreign = createFakeV2Context({
      location: { directory: '/project-b' },
      event: { subscribe: stream.subscribe },
      session: {
        get: async () => ({ location: { directory: '/project-a' } }),
      },
    })
    const unresolvable = createFakeV2Context({
      location: { directory: '/project-c' },
      event: { subscribe: stream.subscribe },
      session: {
        get: async () => {
          throw new Error('lookup failed')
        },
      },
    })
    cleanups.push(await pluginModule.setup(owner.ctx))
    cleanups.push(await pluginModule.setup(foreign.ctx))
    cleanups.push(await pluginModule.setup(unresolvable.ctx))

    stream.push({
      id: 'evt_text',
      type: V2_EVENT_TYPES.sessionTextEnded,
      data: { sessionID: 'ses-a', assistantMessageID: 'msg-a', ordinal: 0, text: 'full text' },
    })
    stream.push({ id: 'evt_barrier', type: V2_EVENT_TYPES.sessionIdle, data: { sessionID: 'ses-barrier' } })
    await waitFor(() => receivedFor('/project-c').length > 0)

    expect(receivedFor('/project-a')).toEqual([
      {
        type: FORGE_EVENT_TYPES.messagePartUpdated,
        properties: {
          sessionID: 'ses-a',
          part: { sessionID: 'ses-a', messageID: 'msg-a', type: 'text', text: 'full text' },
        },
      },
      { type: V2_EVENT_TYPES.sessionIdle, properties: { sessionID: 'ses-barrier' } },
    ])
    expect(receivedFor('/project-b')).toEqual([
      { type: V2_EVENT_TYPES.sessionIdle, properties: { sessionID: 'ses-barrier' } },
    ])
    expect(receivedFor('/project-c')).toEqual([
      { type: V2_EVENT_TYPES.sessionIdle, properties: { sessionID: 'ses-barrier' } },
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

    stream.push({ id: 'evt_after', type: V2_EVENT_TYPES.sessionIdle, data: { sessionID: 'ses-after' } })
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
    stream.push({ id: 'evt_barrier', type: V2_EVENT_TYPES.sessionIdle, data: { sessionID: 'ses-barrier' } })
    await waitFor(() => receivedFor('/project-a').length > 0)

    expect(process.listenerCount('SIGINT')).toBe(baselineSigint + 1)
    expect(stream.signals[0]?.aborted).toBe(false)
  })
})
