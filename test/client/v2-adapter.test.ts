import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createForgeClientFromV2, fromV2Ruleset, resetV2SessionStatusCache, toV2Ruleset } from '../../src/client/v2-adapter'
import type { ForgeToastInput } from '../../src/host/forge-rpc'
import { ForgeClientError } from '../../src/client/port'
import type { ForgeClient } from '../../src/client/port'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createFakeV2Context, type FakeV2ContextOptions } from '../helpers/fake-v2-context'

function clientFor(options: FakeV2ContextOptions & {
  directory?: string
  publishToast?: (toast: ForgeToastInput) => void | Promise<void>
} = {}) {
  const { directory, publishToast, ...contextOptions } = options
  const { ctx, calls } = createFakeV2Context(contextOptions)
  const client = createForgeClientFromV2(ctx, {
    directory: directory ?? '/tmp/forge-project',
    workspace: createFakeForgeClient().client.workspace,
    ...(publishToast ? { publishToast } : {}),
  })
  return { ctx, calls, client }
}

function failure(error: unknown): ForgeClientError {
  expect(error).toBeInstanceOf(ForgeClientError)
  return error as ForgeClientError
}

function sessionInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ses_1',
    projectID: 'proj_fake',
    location: { directory: '/wt' },
    time: { created: 1, updated: 2 },
    ...overrides,
  }
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_assistant',
    type: 'assistant',
    time: { created: 3, completed: 4 },
    agent: 'code',
    model: { id: 'claude-sonnet-4', providerID: 'anthropic' },
    content: [],
    cost: 0.5,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: 'stop',
    ...overrides,
  }
}

describe('createForgeClientFromV2', () => {
  describe('session.create', () => {
    it('maps title, directory, and permissions onto the V2 create input', async () => {
      const { client, calls } = clientFor()

      const created = await client.session.create({
        title: 'Loop 1',
        directory: '/wt',
        permission: [{ permission: 'bash', pattern: 'git push *', action: 'deny' }],
      })

      expect(calls).toEqual([{
        method: 'session.create',
        args: [{
          title: 'Loop 1',
          location: { directory: '/wt' },
          permissions: [{ action: 'shell', resource: 'git push *', effect: 'deny' }],
        }],
      }])
      expect(created.id).toBe('ses_fake_1')
      expect(created.directory).toBe('/wt')
    })

    it('passes a loop title through unchanged', async () => {
      const { client, calls } = clientFor()

      await client.session.create({ title: 'Loop: foo · code #1', directory: '/wt' })

      expect(calls).toEqual([{
        method: 'session.create',
        args: [{ title: 'Loop: foo · code #1', location: { directory: '/wt' } }],
      }])
    })

    it('falls back to the plugin directory when the caller omits one', async () => {
      const { client, calls } = clientFor({ location: { directory: '/tmp/fake-location' } })

      await client.session.create({ title: 'Loop 1' })

      expect(calls).toEqual([{
        method: 'session.create',
        args: [{ title: 'Loop 1', location: { directory: '/tmp/forge-project' } }],
      }])
    })
  })

  describe('session.get', () => {
    it('maps V2 permissions back onto the V1 ruleset', async () => {
      const { client } = clientFor({
        session: {
          get: vi.fn().mockResolvedValue(sessionInfo({
            permissions: [{ action: 'shell', resource: '*', effect: 'deny' }],
          })),
        },
      })

      const info = await client.session.get({ sessionID: 'ses_1' })

      expect(info.permission).toEqual([{ permission: 'bash', pattern: '*', action: 'deny' }])
      expect(info.id).toBe('ses_1')
      expect(info.directory).toBe('/wt')
    })

    it('omits permission when the V2 session has none', async () => {
      const { client } = clientFor()

      const info = await client.session.get({ sessionID: 'ses_1' })

      expect(info.permission).toBeUndefined()
    })
  })

  describe('session.update', () => {
    it('forwards the loop permission ruleset as a V2 ruleset', async () => {
      const { client, calls } = clientFor()

      await client.session.update({
        sessionID: 'ses_1',
        title: 'Loop',
        permission: [{ permission: '*', pattern: '*', action: 'allow' }],
      })

      expect(calls).toEqual([{
        method: 'session.update',
        args: [{ sessionID: 'ses_1', title: 'Loop', permissions: [{ action: '*', resource: '*', effect: 'allow' }] }],
      }])
    })

    it('omits title and permissions when the caller does not set them', async () => {
      const { client, calls } = clientFor()

      await client.session.update({ sessionID: 'ses_1' })

      expect(calls).toEqual([{ method: 'session.update', args: [{ sessionID: 'ses_1' }] }])
    })
  })

  describe('session.promptAsync', () => {
    it('switches agent, switches model, then prompts in order', async () => {
      const { client, calls } = clientFor()

      await client.session.promptAsync({
        sessionID: 'ses_1',
        agent: 'code',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        variant: 'thinking',
        parts: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }],
      })

      expect(calls).toEqual([
        { method: 'session.switchAgent', args: [{ sessionID: 'ses_1', agent: 'code' }] },
        {
          method: 'session.switchModel',
          args: [{ sessionID: 'ses_1', model: { providerID: 'anthropic', id: 'claude-sonnet-4', variant: 'thinking' } }],
        },
        { method: 'session.prompt', args: [{ sessionID: 'ses_1', text: 'hello\n\nworld', delivery: 'queue' }] },
      ])
    })

    it('prompts without switching when no agent or model is set', async () => {
      const { client, calls } = clientFor()

      await client.session.promptAsync({
        sessionID: 'ses_1',
        parts: [{ type: 'text', text: 'hello' }],
      })

      expect(calls).toEqual([
        { method: 'session.prompt', args: [{ sessionID: 'ses_1', text: 'hello', delivery: 'queue' }] },
      ])
    })

    it('rejects non-text parts with a request error before any host call', async () => {
      const { client, calls } = clientFor()

      const err = await client.session.promptAsync({
        sessionID: 'ses_1',
        parts: [{ type: 'file', mime: 'text/plain', filename: 'a.txt', url: 'file:///a.txt' }],
      }).catch((e: unknown) => e)

      expect(failure(err).kind).toBe('request')
      expect(failure(err).method).toBe('session.promptAsync')
      expect(calls).toEqual([])
    })
  })

  describe('session.messages', () => {
    it('maps V2 context messages onto the V1 session message subset', async () => {
      const { client } = clientFor({
        session: {
          context: vi.fn().mockResolvedValue([
            { id: 'msg_user', type: 'user', time: { created: 1 }, text: 'do the work' },
            { id: 'msg_idle', type: 'idle', time: { created: 2 }, outcome: 'succeeded' },
            assistantMessage({
              error: { type: 'APIError', message: 'boom', status: 500 },
              content: [
                { type: 'text', text: 'done' },
                { type: 'reasoning', text: 'thinking' },
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'bash',
                  state: {
                    status: 'completed',
                    input: { command: 'ls' },
                    content: [{ type: 'text', text: 'ok' }],
                    metadata: { title: 'ls' },
                  },
                },
              ],
            }),
          ]),
        },
      })

      const messages = await client.session.messages({ sessionID: 'ses_1' })

      expect(messages.map((message) => message.info.role)).toEqual(['user', 'assistant'])
      expect(messages[0]).toEqual({
        info: { id: 'msg_user', role: 'user', sessionID: 'ses_1', time: { created: 1 } },
        parts: [{ id: 'msg_user', messageID: 'msg_user', sessionID: 'ses_1', type: 'text', text: 'do the work' }],
      })
      expect(messages[1].info).toEqual({
        id: 'msg_assistant',
        role: 'assistant',
        sessionID: 'ses_1',
        time: { created: 3, completed: 4 },
        agent: 'code',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
        cost: 0.5,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: 'stop',
        error: { name: 'APIError', data: { message: 'boom', statusCode: 500 } },
      })
      expect(messages[1].parts).toEqual([
        { id: 'msg_assistant:0', messageID: 'msg_assistant', sessionID: 'ses_1', type: 'text', text: 'done' },
        { id: 'msg_assistant:1', messageID: 'msg_assistant', sessionID: 'ses_1', type: 'reasoning', text: 'thinking' },
        {
          id: 'call_1',
          messageID: 'msg_assistant',
          sessionID: 'ses_1',
          type: 'tool',
          callID: 'call_1',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            output: 'ok',
            metadata: { title: 'ls' },
          },
        },
      ])
    })

    it('keeps the newest messages when a limit is given', async () => {
      const { client } = clientFor({
        session: {
          context: vi.fn().mockResolvedValue([
            { id: 'msg_1', type: 'user', time: { created: 1 }, text: 'one' },
            { id: 'msg_2', type: 'user', time: { created: 2 }, text: 'two' },
            { id: 'msg_3', type: 'user', time: { created: 3 }, text: 'three' },
          ]),
        },
      })

      const messages = await client.session.messages({ sessionID: 'ses_1', limit: 2 })

      expect(messages.map((message) => message.info.id)).toEqual(['msg_2', 'msg_3'])
    })

    it('surfaces a failed tool state as a V1 error string', async () => {
      const { client } = clientFor({
        session: {
          context: vi.fn().mockResolvedValue([
            assistantMessage({
              content: [{
                type: 'tool',
                id: 'call_2',
                name: 'bash',
                state: { status: 'error', input: { command: 'false' }, error: { type: 'ToolError', message: 'exit 1' } },
              }],
            }),
          ]),
        },
      })

      const messages = await client.session.messages({ sessionID: 'ses_1' })

      expect(messages[0].parts[0].state).toEqual({
        status: 'error',
        input: { command: 'false' },
        error: 'exit 1',
        metadata: {},
      })
    })

    it('prepends the cumulative usage remainder not present in visible messages', async () => {
      const { client } = clientFor({
        session: {
          context: vi.fn().mockResolvedValue([assistantMessage()]),
          get: vi.fn().mockResolvedValue(sessionInfo({
            cost: 1.25,
            tokens: { input: 30, output: 50, reasoning: 5, cache: { read: 10, write: 2 } },
            model: { id: 'claude-sonnet-4', providerID: 'anthropic' },
          })),
        },
      })

      const messages = await client.session.messages({ sessionID: 'ses_1' })

      expect(messages[0]).toEqual({
        info: {
          id: 'ses_1:usage-remainder',
          role: 'assistant',
          sessionID: 'ses_1',
          time: { created: 1 },
          cost: 0.75,
          tokens: { input: 20, output: 30, reasoning: 5, cache: { read: 10, write: 2 } },
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
        },
        parts: [],
      })
      expect(messages[1].info.id).toBe('msg_assistant')
    })

    it('omits the remainder when the cumulative totals equal the visible sum', async () => {
      const { client } = clientFor({
        session: {
          context: vi.fn().mockResolvedValue([assistantMessage()]),
          get: vi.fn().mockResolvedValue(sessionInfo({
            cost: 0.5,
            tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          })),
        },
      })

      const messages = await client.session.messages({ sessionID: 'ses_1' })

      expect(messages.map((message) => message.info.id)).toEqual(['msg_assistant'])
    })

    it('maps only the last limit messages and skips the cumulative lookup', async () => {
      const get = vi.fn().mockResolvedValue(sessionInfo({ cost: 9 }))
      const { client } = clientFor({
        session: {
          context: vi.fn().mockResolvedValue([
            { id: 'msg_1', type: 'user', time: { created: 1 }, text: 'one' },
            { id: 'msg_2', type: 'user', time: { created: 2 }, text: 'two' },
            { id: 'msg_3', type: 'user', time: { created: 3 }, text: 'three' },
          ]),
          get,
        },
      })

      const messages = await client.session.messages({ sessionID: 'ses_1', limit: 2 })

      expect(messages.map((message) => message.info.id)).toEqual(['msg_2', 'msg_3'])
      expect(get).not.toHaveBeenCalled()
    })

    it('returns the visible messages when the cumulative lookup fails', async () => {
      const { client } = clientFor({
        session: {
          context: vi.fn().mockResolvedValue([assistantMessage()]),
          get: vi.fn().mockRejectedValue(new Error('Session not found')),
        },
      })

      const messages = await client.session.messages({ sessionID: 'ses_1' })

      expect(messages.map((message) => message.info.id)).toEqual(['msg_assistant'])
    })
  })

  describe('session.status', () => {
    beforeEach(() => resetV2SessionStatusCache())

    it('returns the recorded statuses for known sessions only', async () => {
      const { client } = clientFor()

      await client.recordStatusEvent({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } })
      await client.recordStatusEvent({ type: 'session.idle', properties: { sessionID: 'ses_2' } })
      await client.recordStatusEvent({ type: 'session.status', properties: { sessionID: 'ses_3', status: 'bogus' } })

      expect(await client.session.status()).toEqual({
        ses_1: { type: 'busy' },
        ses_2: { type: 'idle' },
      })
    })

    it('shares recorded statuses across client instances', async () => {
      const first = clientFor()
      const second = clientFor()

      await first.client.recordStatusEvent({
        type: 'session.status',
        properties: { sessionID: 'ses_shared', status: { type: 'busy' } },
      })

      expect(await second.client.session.status()).toEqual({ ses_shared: { type: 'busy' } })
    })

    it('evicts a session when it is deleted', async () => {
      const { client } = clientFor()

      await client.recordStatusEvent({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } })
      await client.recordStatusEvent({ type: 'session.deleted', properties: { sessionID: 'ses_1' } })

      expect(await client.session.status()).toEqual({})
    })

    it('preserves retry status fields', async () => {
      const { client } = clientFor()

      await client.recordStatusEvent({
        type: 'session.status',
        properties: {
          sessionID: 'ses_retry',
          status: { type: 'retry', attempt: 2, message: 'rate limited', next: 123 },
        },
      })

      expect(await client.session.status()).toEqual({
        ses_retry: { type: 'retry', attempt: 2, message: 'rate limited', next: 123 },
      })
    })
  })

  describe('unavailable calls', () => {
    it('session.list rejects as unavailable', async () => {
      const { client } = clientFor()

      expect(failure(await client.session.list({}).catch((e: unknown) => e)).kind).toBe('unavailable')
    })

    it('session.delete rejects as unavailable', async () => {
      const { client } = clientFor()

      const err = failure(await client.session.delete({ sessionID: 'ses_1' }).catch((e: unknown) => e))
      expect(err.kind).toBe('unavailable')
      expect(err.method).toBe('session.delete')
    })

    it('session.delete forwards to requestSessionDelete when the host provides it', async () => {
      const { ctx } = createFakeV2Context()
      const requestSessionDelete = vi.fn().mockResolvedValue(undefined)
      const client = createForgeClientFromV2(ctx, {
        directory: '/tmp/forge-project',
        workspace: createFakeForgeClient().client.workspace,
        requestSessionDelete,
      })

      await client.session.delete({ sessionID: 'ses_1', directory: '/wt' })

      expect(requestSessionDelete).toHaveBeenCalledWith('ses_1')
    })

    it('tui.selectSession rejects as unavailable', async () => {
      const { client } = clientFor()

      expect(failure(await client.tui.selectSession({ sessionID: 'ses_1' }).catch((e: unknown) => e)).kind).toBe('unavailable')
    })
  })

  describe('tui.publish', () => {
    const toastBody = {
      type: 'tui.toast.show',
      properties: { title: 'T', message: 'M', variant: 'success', duration: 1234 },
    } as const

    it('emits the mapped toast payload when an emitter is configured', async () => {
      const publishToast = vi.fn()
      const { client } = clientFor({ publishToast })

      await client.tui.publish({ directory: '/wt', body: toastBody })

      expect(publishToast).toHaveBeenCalledWith({
        title: 'T',
        message: 'M',
        variant: 'success',
        duration: 1234,
      })
    })

    it('ignores non-toast bodies', async () => {
      const publishToast = vi.fn()
      const { client } = clientFor({ publishToast })

      await client.tui.publish({
        directory: '/wt',
        body: { type: 'tui.session.select', properties: { sessionID: 'ses_1' } },
      })

      expect(publishToast).not.toHaveBeenCalled()
    })

    it('resolves without an emitter', async () => {
      const { client } = clientFor()

      await expect(client.tui.publish({ directory: '/wt', body: toastBody })).resolves.toBeUndefined()
    })

    it('resolves and logs when the emitter rejects', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const publishToast = vi.fn().mockRejectedValue(new Error('emit failed'))
      const { client } = clientFor({ publishToast })

      await expect(client.tui.publish({ directory: '/wt', body: toastBody })).resolves.toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith('[forge] failed to emit toast over RPC', expect.any(Error))
      errorSpy.mockRestore()
    })
  })

  describe('session.abort', () => {
    it('interrupts without resuming', async () => {
      const { client, calls } = clientFor()

      await client.session.abort({ sessionID: 'ses_1' })

      expect(calls).toEqual([
        { method: 'session.interrupt', args: [{ sessionID: 'ses_1', resume: false }] },
      ])
    })
  })

  describe('project', () => {
    it('reports the plugin location project for list and current', async () => {
      const { client } = clientFor({ location: { directory: '/repo', project: { id: 'proj_1', canonical: '/repo/canonical' } } })

      expect(await client.project.list()).toEqual([{ id: 'proj_1', worktree: '/repo/canonical' }])
      expect(await client.project.current()).toEqual({ id: 'proj_1', worktree: '/repo/canonical' })
    })
  })

  describe('provider.list', () => {
    it('merges provider and model inventory into the V1 shape', async () => {
      const { client } = clientFor({
        provider: {
          list: vi.fn().mockResolvedValue({
            location: { directory: '/wt' },
            data: [
              { id: 'anthropic', name: 'Anthropic', activation: 'enabled', package: 'x' },
              { id: 'openai', name: 'OpenAI', activation: 'disabled', package: 'y' },
            ],
          }),
        },
        model: {
          list: vi.fn().mockResolvedValue({
            location: { directory: '/wt' },
            data: [
              {
                id: 'sonnet',
                modelID: 'claude-sonnet-4',
                providerID: 'anthropic',
                name: 'Sonnet',
                capabilities: { tools: true, input: ['text'], output: ['text'] },
                variants: [{ id: 'thinking' }],
                time: { released: 0 },
                cost: [{ input: 3, output: 15, cache: { read: 0, write: 0 } }],
                status: 'active',
                enabled: true,
                limit: { context: 1, output: 1 },
              },
            ],
          }),
        },
      })

      const list = await client.provider.list()

      expect(list.connected).toEqual(['anthropic'])
      expect(list.all).toEqual([{
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-sonnet-4': {
            id: 'claude-sonnet-4',
            name: 'Sonnet',
            release_date: new Date(0).toISOString(),
            capabilities: { toolcall: true, reasoning: false },
            cost: { input: 3, output: 15 },
            variants: { thinking: {} },
          },
        },
      }, {
        id: 'openai',
        name: 'OpenAI',
        models: {},
      }])
    })
  })

  describe('event.subscribe', () => {
    it('rejects as unavailable without touching the host', async () => {
      const { client, calls } = clientFor()

      const err = failure(await client.event.subscribe().catch((e: unknown) => e))

      expect(err.kind).toBe('unavailable')
      expect(err.method).toBe('event.subscribe')
      expect(calls).toEqual([])
    })
  })

  describe('no-op calls', () => {
    it('resolves tui.publish and sync.start without touching the host', async () => {
      const { client, calls } = clientFor()

      await expect(client.tui.publish({ directory: '/wt' })).resolves.toBeUndefined()
      await expect(client.sync.start({ directory: '/wt' })).resolves.toBeUndefined()
      expect(calls).toEqual([])
    })
  })
})

describe('toV2Ruleset', () => {
  it('renames bash, task, write, and patch to their V2 actions', () => {
    expect(toV2Ruleset([
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
      { permission: 'task', pattern: '*', action: 'deny' },
      { permission: 'write', pattern: '*.env', action: 'ask' },
      { permission: 'patch', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ])).toEqual([
      { action: 'shell', resource: 'git push *', effect: 'deny' },
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'edit', resource: '*.env', effect: 'ask' },
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
    ])
  })
})

describe('fromV2Ruleset', () => {
  it('restores V1 action names for the inherited-permission check', () => {
    expect(fromV2Ruleset([
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
    ])).toEqual([
      { permission: 'bash', pattern: '*', action: 'deny' },
      { permission: 'task', pattern: '*', action: 'deny' },
      { permission: 'write', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ])
  })
})

describe('error classification', () => {
  it('classifies a thrown "not found" as kind not-found', async () => {
    const { client } = clientFor({
      session: {
        get: vi.fn().mockRejectedValue(new Error('Session not found')),
      },
    })

    const err = failure(await client.session.get({ sessionID: 'ses_1' }).catch((e: unknown) => e))

    expect(err.kind).toBe('not-found')
    expect(err.method).toBe('session.get')
    expect(err.message).toContain('Session not found')
  })

  it('classifies a connection failure as kind connection', async () => {
    const { client } = clientFor({
      session: {
        create: vi.fn().mockRejectedValue(new Error('Unable to connect')),
      },
    })

    const err = failure(await client.session.create({ title: 'Loop 1' }).catch((e: unknown) => e))

    expect(err.kind).toBe('connection')
    expect(err.method).toBe('session.create')
  })
})

describe('workspace namespace', () => {
  it('passes the provided workspace namespace through unchanged', () => {
    const { client } = clientFor()

    expect(client.workspace).toBeDefined()
    expect(typeof client.workspace.create).toBe('function')
    expect(typeof client.workspace.warp).toBe('function')
  })
})

describe('ForgeClient surface', () => {
  it('exposes every port namespace on the returned client', () => {
    const { client } = clientFor()
    const surface: ForgeClient = client

    expect(Object.keys(surface).sort()).toEqual([
      'event',
      'project',
      'provider',
      'recordStatusEvent',
      'session',
      'sync',
      'tui',
      'workspace',
    ])
  })
})
