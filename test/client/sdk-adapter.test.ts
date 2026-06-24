import { describe, it, expect, vi } from 'vitest'
import { createForgeClient, createV2ClientFromPluginInput } from '../../src/client/sdk-adapter'
import { ForgeClientError } from '../../src/client/port'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { PluginInput } from '@opencode-ai/plugin'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal stub v2 client with the given overrides. */
function stubV2(overrides?: {
  session?: Partial<Record<keyof OpencodeClient['session'], ReturnType<typeof vi.fn>>>
  experimental?: {
    workspace?: Partial<Record<keyof NonNullable<OpencodeClient['experimental']>['workspace'], ReturnType<typeof vi.fn>>>
  }
  tui?: Partial<Record<keyof NonNullable<OpencodeClient['tui']>, ReturnType<typeof vi.fn>>>
  sync?: { start?: ReturnType<typeof vi.fn> }
}): OpencodeClient {
  const sessionApi = {
    create: vi.fn().mockResolvedValue({ data: { id: 's1' }, error: undefined }),
    get: vi.fn().mockResolvedValue({ data: { id: 's1' }, error: undefined }),
    update: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
    messages: vi.fn().mockResolvedValue({ data: [], error: undefined }),
    status: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
    promptAsync: vi.fn().mockResolvedValue({ data: undefined, error: undefined }),
    abort: vi.fn().mockResolvedValue({ data: true, error: undefined }),
    delete: vi.fn().mockResolvedValue({ data: true, error: undefined }),
    ...overrides?.session,
  } as unknown as OpencodeClient['session']

  const workspaceApi = overrides?.experimental?.workspace ?? {
    create: vi.fn().mockResolvedValue({ data: { id: 'ws-1' }, error: undefined }),
    list: vi.fn().mockResolvedValue({ data: [], error: undefined }),
    status: vi.fn().mockResolvedValue({ data: [], error: undefined }),
    syncList: vi.fn().mockResolvedValue({ data: undefined, error: undefined }),
    remove: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
    warp: vi.fn().mockResolvedValue({ data: undefined, error: undefined }),
  }

  const tuiApi = overrides?.tui ?? {
    publish: vi.fn().mockResolvedValue({ data: true, error: undefined }),
    selectSession: vi.fn().mockResolvedValue({ data: true, error: undefined }),
  }

  const syncApi = overrides?.sync ?? {
    start: vi.fn().mockResolvedValue({ data: true, error: undefined }),
  }

  return {
    session: sessionApi,
    experimental: { workspace: workspaceApi },
    tui: tuiApi,
    sync: syncApi,
  } as unknown as OpencodeClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createForgeClient', () => {
  // ── session.create happy path ─────────────────────────────────────────
  it('session.create resolves to data on success', async () => {
    const v2 = stubV2()
    const client = createForgeClient(v2)

    const result = await client.session.create({ directory: '/test' })

    expect(result).toEqual({ id: 's1' })
    expect(v2.session.create).toHaveBeenCalledWith({ directory: '/test' })
  })

  // ── { error } envelope ───────────────────────────────────────────────
  it('session.create throws ForgeClientError with kind="not-found" when SDK returns error envelope', async () => {
    const sdkError = new Error('Session not found')
    const v2 = stubV2({
      session: {
        create: vi.fn().mockResolvedValue({ data: null, error: sdkError }),
      },
    })
    const client = createForgeClient(v2)

    const err = await client.session.create({ directory: '/test' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ForgeClientError)
    expect((err as ForgeClientError).kind).toBe('not-found')
    expect((err as ForgeClientError).method).toBe('session.create')
    expect((err as ForgeClientError).message).toContain('Session not found')
  })

  // ── data: null without error ──────────────────────────────────────────
  it('session.create throws ForgeClientError when SDK returns data: null without error', async () => {
    const v2 = stubV2({
      session: {
        create: vi.fn().mockResolvedValue({ data: null, error: undefined }),
      },
    })
    const client = createForgeClient(v2)

    const err = await client.session.create({ directory: '/test' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ForgeClientError)
    expect((err as ForgeClientError).kind).toBe('request')
    expect((err as ForgeClientError).method).toBe('session.create')
    expect((err as ForgeClientError).message).toContain('no data returned')
  })

  // ── thrown SDK error ─────────────────────────────────────────────────
  it('session.create throws ForgeClientError with kind="connection" when SDK throws', async () => {
    const v2 = stubV2({
      session: {
        create: vi.fn().mockRejectedValue(new Error('Unable to connect')),
      },
    })
    const client = createForgeClient(v2)

    const err = await client.session.create({ directory: '/test' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ForgeClientError)
    expect((err as ForgeClientError).kind).toBe('connection')
    expect((err as ForgeClientError).method).toBe('session.create')
  })

  // ── workspace.warp with { error } ────────────────────────────────────
  it('workspace.warp throws classified ForgeClientError when SDK returns error', async () => {
    const sdkError = { name: 'WorkspaceWarpError', data: { message: 'Workspace not found' } }
    const v2 = stubV2({
      experimental: {
        workspace: {
          warp: vi.fn().mockResolvedValue({ data: undefined, error: sdkError }),
        },
      },
    })
    const client = createForgeClient(v2)

    const err = await client.workspace.warp({ id: 'ws-1', sessionID: 's1' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ForgeClientError)
    expect((err as ForgeClientError).kind).toBe('not-found')
    expect((err as ForgeClientError).method).toBe('workspace.warp')
    expect((err as ForgeClientError).message).toContain('Workspace not found')
  })

  // ── missing experimental.workspace namespace ─────────────────────────
  it('workspace.list throws ForgeClientError with kind="unavailable" when experimental.workspace is missing', async () => {
    const v2 = {
      session: stubV2().session,
      tui: stubV2().tui,
      sync: stubV2().sync,
    } as unknown as OpencodeClient
    const client = createForgeClient(v2)

    const err = await client.workspace.list({}).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ForgeClientError)
    expect((err as ForgeClientError).kind).toBe('unavailable')
    expect((err as ForgeClientError).method).toBe('workspace.list')
  })

  // ── missing tui namespace → publish resolves silently ────────────────
  it('tui.publish resolves without throwing when tui namespace is missing', async () => {
    const v2 = {
      session: stubV2().session,
      experimental: stubV2().experimental,
      sync: stubV2().sync,
    } as unknown as OpencodeClient
    const client = createForgeClient(v2)

    await expect(client.tui.publish({ directory: '/test' })).resolves.toBeUndefined()
  })

  // ── missing sync namespace → start resolves silently ─────────────────
  it('sync.start resolves without throwing when sync.start is missing', async () => {
    const v2 = {
      session: stubV2().session,
      experimental: stubV2().experimental,
      tui: stubV2().tui,
    } as unknown as OpencodeClient
    const client = createForgeClient(v2)

    await expect(client.sync.start({ directory: '/test' })).resolves.toBeUndefined()
  })

  // ── missing tui namespace → selectSession throws unavailable ─────────
  it('tui.selectSession throws ForgeClientError with kind="unavailable" when tui namespace is missing', async () => {
    const v2 = {
      session: stubV2().session,
      experimental: stubV2().experimental,
      sync: stubV2().sync,
    } as unknown as OpencodeClient
    const client = createForgeClient(v2)

    const err = await client.tui.selectSession({ sessionID: 's1' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ForgeClientError)
    expect((err as ForgeClientError).kind).toBe('unavailable')
    expect((err as ForgeClientError).method).toBe('tui.selectSession')
  })

  // ── error code propagation ────────────────────────────────────────────
  it('ForgeClientError propagates code from cause.code (e.g. concurrent_prompt)', async () => {
    const sdkError = new Error('concurrent prompt in progress')
    ;(sdkError as any).code = 'concurrent_prompt'
    const v2 = stubV2({
      session: {
        promptAsync: vi.fn().mockResolvedValue({ data: undefined, error: sdkError }),
      },
    })
    const client = createForgeClient(v2)

    const err = await client.session.promptAsync({
      sessionID: 's1',
      directory: '/test',
      agent: 'code',
      parts: [{ type: 'text', text: 'hello' }],
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ForgeClientError)
    expect((err as ForgeClientError).code).toBe('concurrent_prompt')
    expect((err as ForgeClientError).kind).toBe('request')
    expect((err as ForgeClientError).message).toContain('concurrent prompt in progress')
  })

  // ── project.list ──────────────────────────────────────────────────────
  it('project.list resolves to data on success', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ id: 'p1', worktree: '/wt' }], error: undefined })
    const client = createForgeClient({ project: { list } } as unknown as OpencodeClient)

    const result = await client.project.list({ directory: '/wt' })

    expect(result).toEqual([{ id: 'p1', worktree: '/wt' }])
    expect(list).toHaveBeenCalledWith({ directory: '/wt' })
  })

  // ── provider.list ─────────────────────────────────────────────────────
  it('provider.list resolves to data on success', async () => {
    const list = vi.fn().mockResolvedValue({ data: { all: [], connected: ['anthropic'] }, error: undefined })
    const client = createForgeClient({ provider: { list } } as unknown as OpencodeClient)

    const result = await client.provider.list({ directory: '/wt' })

    expect(result).toEqual({ all: [], connected: ['anthropic'] })
  })

  // ── session.list (experimental) ──────────────────────────────────────
  it('session.list resolves to data from experimental.session', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ id: 'ses1' }], error: undefined })
    const client = createForgeClient({ experimental: { session: { list } } } as unknown as OpencodeClient)

    const result = await client.session.list({ directory: '/wt' })

    expect(result).toEqual([{ id: 'ses1' }])
    expect(list).toHaveBeenCalledWith({ directory: '/wt' })
  })

  it('session.list throws ForgeClientError with kind="unavailable" when experimental.session is missing', async () => {
    const v2 = {
      session: stubV2().session,
      experimental: { workspace: stubV2().experimental!.workspace },
    } as unknown as OpencodeClient
    const client = createForgeClient(v2)

    const err = await client.session.list({}).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ForgeClientError)
    expect((err as ForgeClientError).kind).toBe('unavailable')
    expect((err as ForgeClientError).method).toBe('session.list')
  })
})

describe('createForgeClient events.subscribeGlobal', () => {
  /** Build an async-iterable stream from a fixed list of events. */
  function streamOf<T>(items: T[]): AsyncIterable<T> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const item of items) yield item
      },
    }
  }

  it('forwards each global event with directory + payload to onEvent', async () => {
    const events = [
      { directory: '/proj/a', payload: { type: 'session.idle', properties: { sessionID: 's1' } } },
      { directory: '/proj/b', payload: { type: 'session.created', properties: {} } },
    ]
    const globalEvent = vi.fn().mockResolvedValue({ stream: streamOf(events) })
    const v2 = { ...stubV2(), global: { event: globalEvent } } as unknown as OpencodeClient
    const client = createForgeClient(v2)

    const received: { directory: string; payload: unknown }[] = []
    client.events.subscribeGlobal((e) => received.push(e))

    // Allow the detached async loop to drain.
    await new Promise((r) => setTimeout(r, 0))

    expect(globalEvent).toHaveBeenCalledTimes(1)
    expect(received).toEqual(events)
  })

  it('calls global.event bound to its namespace (preserves `this`)', async () => {
    // Mirror the real SDK v2 shape: `global` is an instance whose `event`
    // method reads `this.client`. An unbound call throws
    // "Cannot read properties of undefined (reading 'sse')" / "this.client",
    // which previously killed the feed silently.
    const events = [{ directory: '/p', payload: { type: 'session.idle', properties: { sessionID: 's1' } } }]
    const globalApi = {
      client: { ok: true },
      event(this: { client: unknown }) {
        // Throws if `this` is lost (the regression we guard against).
        if (!this || !this.client) throw new Error("this.client is undefined")
        return Promise.resolve({ stream: streamOf(events) })
      },
    }
    const v2 = { ...stubV2(), global: globalApi } as unknown as OpencodeClient
    const client = createForgeClient(v2)

    const received: { directory: string; payload: unknown }[] = []
    const onError = vi.fn()
    client.events.subscribeGlobal((e) => received.push(e), { onError })

    await new Promise((r) => setTimeout(r, 0))

    expect(onError).not.toHaveBeenCalled()
    expect(received).toEqual(events)
  })

  it('invokes onError with an unavailable error when global.event is missing', () => {
    const v2 = stubV2() // no `global` namespace
    const client = createForgeClient(v2)

    const onError = vi.fn()
    const detach = client.events.subscribeGlobal(() => {}, { onError })

    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0]
    expect(err).toBeInstanceOf(ForgeClientError)
    expect((err as ForgeClientError).kind).toBe('unavailable')
    // Detach is a safe no-op.
    expect(() => detach()).not.toThrow()
  })

  it('detach aborts the request and suppresses post-detach stream errors', async () => {
    let abortSignal: AbortSignal | undefined
    const globalEvent = vi.fn().mockImplementation((opts?: { signal?: AbortSignal }) => {
      abortSignal = opts?.signal
      // Never-resolving stream; we only assert the signal is aborted on detach.
      return Promise.resolve({ stream: streamOf<unknown>([]) })
    })
    const v2 = { ...stubV2(), global: { event: globalEvent } } as unknown as OpencodeClient
    const client = createForgeClient(v2)

    const onError = vi.fn()
    const detach = client.events.subscribeGlobal(() => {}, { onError })
    detach()

    await new Promise((r) => setTimeout(r, 0))

    expect(abortSignal?.aborted).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('createV2ClientFromPluginInput', () => {
  it('returns a v2 client constructed from the legacy PluginInput', async () => {
    const fakeFetch = vi.fn()
    const fakeHeaders = new Headers({ authorization: 'Bearer test-token' })

    const fakePluginInput = {
      client: {
        _client: {
          getConfig: () => ({
            fetch: fakeFetch,
            headers: fakeHeaders,
          }),
        },
      } as unknown as PluginInput['client'],
      directory: '/test/dir',
      serverUrl: new URL('http://localhost:9999'),
      project: { id: 'test-project', name: 'Test' },
      worktree: '/test/wt',
      experimental_workspace: { register: () => {} },
      $: {} as never,
    } as PluginInput

    const v2Client = createV2ClientFromPluginInput(fakePluginInput)

    // Structural smoke test: returned object has .session
    expect(v2Client).toBeDefined()
    expect(v2Client.session).toBeDefined()
    // Can call session methods
    expect(typeof v2Client.session.create).toBe('function')
  })
})
