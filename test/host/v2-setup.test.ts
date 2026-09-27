import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FORGE_EVENT_TYPES, V2_EVENT_TYPES } from '../../src/host/v2-events'
import { FORGE_RPC } from '../../src/host/forge-rpc'
import { VERSION } from '../../src/version'
import { isPromptQueued, hasSuppressedIdle, recordSuppressedIdle, __resetIdleGate } from '../../src/loop/idle-gate'
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
    __resetIdleGate()
    const dataHome = mkdtempSync(join(tmpdir(), 'forge-v2-setup-data-'))
    dataHomes.push(dataHome)
    process.env['XDG_DATA_HOME'] = dataHome
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => {})
    }
    __resetIdleGate()
    delete process.env['XDG_DATA_HOME']
    for (const dir of dataHomes.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('default export is the V2 plugin definition', () => {
    expect(pluginModule.id).toBe('oc-forge')
    expect(typeof pluginModule.setup).toBe('function')
  })

  test('setup registers the Forge tools, agents, commands, and hooks', async () => {
    const fake = createFakeV2Context()

    cleanups.push(await pluginModule.setup(fake.ctx))

    expect(fake.calls.filter((call) => call.method === 'tool.transform')).toHaveLength(2)
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

    await lastClient().toast({
      directory: '/tmp/forge-project',
      title: 'Loop done',
      message: 'All sections passed',
      variant: 'success',
      duration: 4000,
    })

    expect(fake.rpc.emitted).toContainEqual({
      event: 'toast',
      data: {
        projectId: 'proj_fake',
        title: 'Loop done',
        message: 'All sections passed',
        variant: 'success',
        duration: 4000,
      },
    })
  })

  test('the version RPC returns the generated package version', async () => {
    const fake = createFakeV2Context()
    cleanups.push(await pluginModule.setup(fake.ctx))
    const handlers = fake.rpc.registrations[0]?.handlers as {
      version: () => Promise<Record<string, unknown>>
    }

    await expect(handlers.version()).resolves.toEqual({ version: VERSION })
  })

  test('the loopDefaults RPC returns the core loop-setting defaults', async () => {
    const fake = createFakeV2Context()
    cleanups.push(await pluginModule.setup(fake.ctx))
    const handlers = fake.rpc.registrations[0]?.handlers as {
      loopDefaults: () => Promise<Record<string, unknown>>
    }

    const result = await handlers.loopDefaults()
    expect(typeof result.maxIterations).toBe('number')
    expect(result.sandbox).toEqual({
      available: true,
      resources: { memory: '8g', cpus: '4', dockerDisk: '16g', cacheDisk: '16g' },
    })
  })

  test('bridges host sandbox changes to the hostSandboxChanged RPC event', async () => {
    const fake = createFakeV2Context()
    cleanups.push(await pluginModule.setup(fake.ctx))
    const handlers = fake.rpc.registrations[0]?.handlers as {
      hostSandboxSet: (input: { sessionId: string; enabled: boolean }) => Promise<Record<string, unknown>>
    }

    const result = await handlers.hostSandboxSet({ sessionId: 'ses_host', enabled: true })
    expect(typeof result.revision).toBe('string')
    expect(fake.rpc.emitted).toContainEqual({
      event: 'hostSandboxChanged',
      data: { projectId: 'proj_fake' },
    })
  })

  test('bridges client session deletes to the sessionDelete RPC event', async () => {
    const fake = createFakeV2Context()

    cleanups.push(await pluginModule.setup(fake.ctx))

    await lastClient().session.delete({ sessionID: 'ses_retired', directory: '/tmp/forge-project' })

    expect(fake.rpc.emitted).toContainEqual({ event: 'sessionDelete', data: { sessionID: 'ses_retired' } })
  })

  test('the executePlan RPC runs execute-here and new-session through the execution service', async () => {
    const fake = createFakeV2Context()
    cleanups.push(await pluginModule.setup(fake.ctx))
    const handlers = fake.rpc.registrations[0]?.handlers as {
      executePlan: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
    }

    await expect(handlers.executePlan({
      sessionId: 'ses_host',
      mode: 'execute-here',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
      executionModel: 'anthropic/claude',
      executionVariant: 'high',
    })).resolves.toEqual({ sessionId: 'ses_host' })

    const hereModel = fake.calls.find((call) => call.method === 'session.switchModel')
    expect(hereModel?.args[0]).toEqual({
      sessionID: 'ses_host',
      model: { providerID: 'anthropic', id: 'claude', variant: 'high' },
    })
    const herePrompt = fake.calls.find((call) => call.method === 'session.prompt')
    expect((herePrompt?.args[0] as { sessionID: string; text: string })).toMatchObject({ sessionID: 'ses_host' })
    expect((herePrompt?.args[0] as { text: string }).text).toContain('Do the thing')

    await expect(handlers.executePlan({
      sessionId: 'ses_host',
      mode: 'new-session',
      title: 'Ship it',
      plan: '# Plan\n\nDo the thing',
    })).resolves.toEqual({ sessionId: 'ses_fake_1' })
  })

  test('the executePlan RPC reports execute-here without a session as an error', async () => {
    const fake = createFakeV2Context()
    cleanups.push(await pluginModule.setup(fake.ctx))
    const handlers = fake.rpc.registrations[0]?.handlers as {
      executePlan: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
    }

    await expect(handlers.executePlan({ sessionId: '', mode: 'execute-here', title: 'T', plan: '# Plan' }))
      .resolves.toEqual({ error: 'Execute here requires a current session' })
  })

  test('the autoApprove RPC reads and toggles the per-session flag', async () => {
    const fake = createFakeV2Context()
    cleanups.push(await pluginModule.setup(fake.ctx))
    const handlers = fake.rpc.registrations[0]?.handlers as {
      autoApproveState: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
      autoApproveSet: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
    }

    await expect(handlers.autoApproveState({ sessionId: 'ses_auto' })).resolves.toEqual({ enabled: false, inherited: false })
    await expect(handlers.autoApproveSet({ sessionId: 'ses_auto', enabled: true })).resolves.toEqual({
      enabled: true,
      ownerSessionId: 'ses_auto',
      inherited: false,
    })
    await expect(handlers.autoApproveState({ sessionId: 'ses_auto' })).resolves.toEqual({
      enabled: true,
      ownerSessionId: 'ses_auto',
      inherited: false,
    })
    await expect(handlers.autoApproveSet({ sessionId: 'ses_auto', enabled: false })).resolves.toEqual({
      enabled: false,
      inherited: false,
    })
  })

  test('the loop, plan, and sandbox RPC handlers route to the core TUI service', async () => {
    const fake = createFakeV2Context()
    cleanups.push(await pluginModule.setup(fake.ctx))
    const handlers = fake.rpc.registrations[0]?.handlers as {
      loops: () => Promise<Record<string, unknown>>
      loopSidebar: (input: { limit: number }) => Promise<Record<string, unknown>>
      sessionPlan: (input: { sessionId: string }) => Promise<Record<string, unknown>>
      loopRestart: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
      hostSandboxState: () => Promise<Record<string, unknown>>
      hostSandboxSet: (input: { sessionId: string; enabled: boolean }) => Promise<Record<string, unknown>>
      worktrees: () => Promise<Record<string, unknown>>
    }

    expect(typeof handlers.loopRestart).toBe('function')

    await expect(handlers.loops()).resolves.toEqual({ loops: [] })
    await expect(handlers.loopSidebar({ limit: 5 })).resolves.toEqual({ loops: [] })
    await expect(handlers.sessionPlan({ sessionId: 'ses_none' })).resolves.toEqual({})

    const hostState = await handlers.hostSandboxState()
    expect(hostState.configEnabled).toBe(true)

    const set = await handlers.hostSandboxSet({ sessionId: 'ses_host', enabled: true })
    expect(typeof set.revision).toBe('string')

    const worktrees = await handlers.worktrees()
    expect(typeof worktrees.root).toBe('string')
    expect(worktrees.dirs).toEqual([])
  })

  test('a registration failure does not reject setup and drops toasts', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = createFakeV2Context({
      rpc: { register: vi.fn().mockRejectedValue(new Error('rpc unavailable')) },
    })

    cleanups.push(await pluginModule.setup(fake.ctx))

    expect(errorSpy).toHaveBeenCalledWith('[forge] failed to register toast RPC', expect.any(Error))
    errorSpy.mockRestore()

    await expect(lastClient().toast({
      directory: '/tmp/forge-project',
      message: 'Dropped',
      variant: 'warning',
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

  test('an inbox event updates the process-wide queue before ownership filtering, and settling clears it', async () => {
    const stream = createV2EventStream()
    const fake = createFakeV2Context({
      location: { directory: '/project-a' },
      event: { subscribe: stream.subscribe },
      session: {
        get: async (input: { sessionID: string }) => ({
          id: input.sessionID,
          projectID: 'proj_fake',
          location: { directory: '/project-foreign' },
          time: { created: 1, updated: 1 },
        }),
      },
    })

    cleanups.push(await pluginModule.setup(fake.ctx))

    stream.push({
      id: 'evt_inbox_enqueued',
      type: V2_EVENT_TYPES.sessionInboxEnqueued,
      data: { sessionID: 'ses_loop', inboxID: 'inbox_1' },
    })
    await waitFor(() => isPromptQueued('ses_loop'))

    // The session is owned by a foreign location, so nothing reached the loop core.
    expect(receivedFor('/project-a')).toEqual([])

    stream.push({
      id: 'evt_inbox_delivered',
      type: V2_EVENT_TYPES.sessionInboxDelivered,
      data: { sessionID: 'ses_loop', inboxID: 'inbox_1' },
    })
    await waitFor(() => !isPromptQueued('ses_loop'))
  })

  test('a cancelled inbox event replays the suppressed idle once in the owning instance only', async () => {
    const stream = createV2EventStream()
    const sessionGet = async (input: { sessionID: string }) => ({
      id: input.sessionID,
      projectID: 'proj_fake',
      location: { directory: '/project-worktree' },
      time: { created: 1, updated: 1 },
    })
    const host = createFakeV2Context({
      location: { directory: '/project-host' },
      event: { subscribe: stream.subscribe },
      session: { get: sessionGet },
    })
    const worktree = createFakeV2Context({
      location: { directory: '/project-worktree' },
      event: { subscribe: stream.subscribe },
      session: { get: sessionGet },
    })
    cleanups.push(await pluginModule.setup(host.ctx))
    cleanups.push(await pluginModule.setup(worktree.ctx))

    stream.push({
      id: 'evt_inbox_enqueued',
      type: V2_EVENT_TYPES.sessionInboxEnqueued,
      data: { sessionID: 'ses_loop', inboxID: 'inbox_1' },
    })
    await waitFor(() => isPromptQueued('ses_loop'))

    recordSuppressedIdle('ses_loop')

    stream.push({
      id: 'evt_inbox_cancelled',
      type: V2_EVENT_TYPES.sessionInboxCancelled,
      data: { sessionID: 'ses_loop', inboxID: 'inbox_1' },
    })
    await waitFor(() => receivedFor('/project-worktree').some(
      (event) => event.type === FORGE_EVENT_TYPES.sessionIdle && event.properties.sessionID === 'ses_loop',
    ))

    const worktreeIdles = receivedFor('/project-worktree').filter(
      (event) => event.type === FORGE_EVENT_TYPES.sessionIdle && event.properties.sessionID === 'ses_loop',
    )
    expect(worktreeIdles).toHaveLength(1)
    expect(receivedFor('/project-host').some((event) => event.properties.sessionID === 'ses_loop')).toBe(false)
    expect(hasSuppressedIdle('ses_loop')).toBe(false)
  })

  test('a delivered inbox event clears the suppressed idle without replaying', async () => {
    const stream = createV2EventStream()
    const fake = createFakeV2Context({
      location: { directory: '/project-worktree' },
      event: { subscribe: stream.subscribe },
    })
    cleanups.push(await pluginModule.setup(fake.ctx))

    stream.push({
      id: 'evt_inbox_enqueued',
      type: V2_EVENT_TYPES.sessionInboxEnqueued,
      data: { sessionID: 'ses_loop', inboxID: 'inbox_1' },
    })
    await waitFor(() => isPromptQueued('ses_loop'))
    recordSuppressedIdle('ses_loop')

    stream.push({
      id: 'evt_inbox_delivered',
      type: V2_EVENT_TYPES.sessionInboxDelivered,
      data: { sessionID: 'ses_loop', inboxID: 'inbox_1' },
    })
    await waitFor(() => !isPromptQueued('ses_loop'))

    expect(hasSuppressedIdle('ses_loop')).toBe(false)
    expect(receivedFor('/project-worktree').some((event) => event.type === FORGE_EVENT_TYPES.sessionIdle)).toBe(false)
  })

  test('a session.deleted event clears queued entries and the suppressed idle', async () => {
    const stream = createV2EventStream()
    const fake = createFakeV2Context({
      location: { directory: '/project-a' },
      event: { subscribe: stream.subscribe },
    })
    cleanups.push(await pluginModule.setup(fake.ctx))

    stream.push({
      id: 'evt_inbox_enqueued',
      type: V2_EVENT_TYPES.sessionInboxEnqueued,
      data: { sessionID: 'ses_loop', inboxID: 'inbox_1' },
    })
    await waitFor(() => isPromptQueued('ses_loop'))
    recordSuppressedIdle('ses_loop')

    stream.push({
      id: 'evt_deleted',
      type: V2_EVENT_TYPES.sessionDeleted,
      data: { sessionID: 'ses_loop' },
    })
    await waitFor(() => !isPromptQueued('ses_loop'))

    expect(hasSuppressedIdle('ses_loop')).toBe(false)
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

  test('a session created in another location reaches only the instance that owns it', async () => {
    const stream = createV2EventStream()
    const host = createFakeV2Context({ location: { directory: '/project-host' }, event: { subscribe: stream.subscribe } })
    const worktree = createFakeV2Context({ location: { directory: '/project-worktree' }, event: { subscribe: stream.subscribe } })
    cleanups.push(await pluginModule.setup(host.ctx))
    cleanups.push(await pluginModule.setup(worktree.ctx))

    stream.push({
      id: 'evt_created',
      type: V2_EVENT_TYPES.sessionCreated,
      created: 1,
      data: { sessionID: 'ses_loop', projectID: 'proj_fake', location: { directory: '/project-worktree' } },
    })
    stream.push({ id: 'evt_idle', type: V2_EVENT_TYPES.sessionExecutionSucceeded, data: { sessionID: 'ses_loop' } })
    stream.push({ id: 'evt_barrier', type: V2_EVENT_TYPES.sessionExecutionStarted, data: { sessionID: 'ses_host' } })
    await waitFor(() => receivedFor('/project-host').some((event) => event.properties.sessionID === 'ses_host'))
    await waitFor(() => receivedFor('/project-worktree').some((event) => event.type === FORGE_EVENT_TYPES.sessionIdle))

    expect(receivedFor('/project-host').some((event) => event.properties.sessionID === 'ses_loop')).toBe(false)
    const loopEvents = receivedFor('/project-worktree').filter((event) =>
      event.properties.sessionID === 'ses_loop' || (event.properties.info as { id?: string } | undefined)?.id === 'ses_loop')
    expect(loopEvents.map((event) => event.type)).toEqual([
      FORGE_EVENT_TYPES.sessionCreated,
      FORGE_EVENT_TYPES.sessionStatus,
      FORGE_EVENT_TYPES.sessionIdle,
    ])
  })

  test('an unseen session is attributed by its looked-up location, and a failed lookup still delivers', async () => {
    const stream = createV2EventStream()
    const fake = createFakeV2Context({
      location: { directory: '/project-host' },
      event: { subscribe: stream.subscribe },
      session: {
        get: async (input: { sessionID: string }) => {
          if (input.sessionID === 'ses_unknown') throw new Error('session lookup failed')
          return {
            id: input.sessionID,
            projectID: 'proj_fake',
            location: { directory: input.sessionID.startsWith('ses_foreign') ? '/project-worktree' : '/project-host' },
            time: { created: 1, updated: 1 },
          }
        },
      },
    })
    cleanups.push(await pluginModule.setup(fake.ctx))

    stream.push({ id: 'evt_foreign', type: V2_EVENT_TYPES.sessionExecutionStarted, data: { sessionID: 'ses_foreign' } })
    stream.push({ id: 'evt_foreign_idle', type: V2_EVENT_TYPES.sessionExecutionSucceeded, data: { sessionID: 'ses_foreign' } })
    stream.push({ id: 'evt_foreign_busy', type: V2_EVENT_TYPES.sessionExecutionStarted, data: { sessionID: 'ses_foreign_busy' } })
    stream.push({ id: 'evt_unknown', type: V2_EVENT_TYPES.sessionExecutionStarted, data: { sessionID: 'ses_unknown' } })
    stream.push({ id: 'evt_local', type: V2_EVENT_TYPES.sessionExecutionStarted, data: { sessionID: 'ses_local' } })
    await waitFor(() => receivedFor('/project-host').some((event) => event.properties.sessionID === 'ses_local'))

    expect(receivedFor('/project-host').map((event) => event.properties.sessionID)).toEqual(['ses_unknown', 'ses_local'])
    const statuses = await lastClient().session.status({ directory: '/project-worktree' })
    expect(statuses?.ses_foreign).toEqual({ type: 'idle' })
    expect(statuses?.ses_foreign_busy).toEqual({ type: 'busy' })
    expect(fake.calls.filter((call) => call.method === 'session.get' && (call.args[0] as { sessionID: string }).sessionID === 'ses_foreign')).toHaveLength(1)
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
