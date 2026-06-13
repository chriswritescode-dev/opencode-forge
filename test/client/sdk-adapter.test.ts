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
