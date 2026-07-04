import { describe, it, expect, vi } from 'vitest'
import {
  buildBasicAuthHeader,
  createRemoteForgeClient,
} from '../../src/client/sdk-adapter'
import type { ForgeClient } from '../../src/client/port'

// ---------------------------------------------------------------------------
// buildBasicAuthHeader
// ---------------------------------------------------------------------------

describe('buildBasicAuthHeader', () => {
  it('encodes username:password as Base64 Basic token', () => {
    const result = buildBasicAuthHeader('opencode', 'pw')
    // Buffer.from('opencode:pw').toString('base64') → 'b3BlbmNvZGU6cHc='
    expect(result).toBe('Basic b3BlbmNvZGU6cHc=')
  })

  it('encodes special characters correctly', () => {
    const result = buildBasicAuthHeader('user', 'p@ss:w0rd!')
    const expected = `Basic ${Buffer.from('user:p@ss:w0rd!').toString('base64')}`
    expect(result).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// createRemoteForgeClient – structural smoke test
// ---------------------------------------------------------------------------

describe('createRemoteForgeClient', () => {
  it('returns a ForgeClient with all expected namespaces', () => {
    const client = createRemoteForgeClient({
      url: 'http://remote:4096',
      username: 'opencode',
      password: 'secret',
    })

    expect(client).toBeDefined()
    expect(typeof client.session).toBe('object')
    expect(typeof client.workspace).toBe('object')
    expect(typeof client.project).toBe('object')
    expect(typeof client.provider).toBe('object')
    expect(typeof client.tui).toBe('object')
    expect(typeof client.sync).toBe('object')
  })

  // ── Namespace method smoke tests ──────────────────────────────────────────
  it('session.create is a function', () => {
    const client = createRemoteForgeClient({ url: 'http://remote:4096' })
    expect(typeof client.session.create).toBe('function')
  })

  it('workspace.create is a function', () => {
    const client = createRemoteForgeClient({ url: 'http://remote:4096' })
    expect(typeof client.workspace.create).toBe('function')
  })

  it('project.list is a function', () => {
    const client = createRemoteForgeClient({ url: 'http://remote:4096' })
    expect(typeof client.project.list).toBe('function')
  })

  it('provider.list is a function', () => {
    const client = createRemoteForgeClient({ url: 'http://remote:4096' })
    expect(typeof client.provider.list).toBe('function')
  })

  it('tui.publish is a function', () => {
    const client = createRemoteForgeClient({ url: 'http://remote:4096' })
    expect(typeof client.tui.publish).toBe('function')
  })

  it('sync.start is a function', () => {
    const client = createRemoteForgeClient({ url: 'http://remote:4096' })
    expect(typeof client.sync.start).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Authorization header behaviour (via injected mock fetch)
// ---------------------------------------------------------------------------

describe('createRemoteForgeClient – Authorization header', () => {
  /** Build a mock fetch that returns an empty success response. */
  function mockFetch() {
    return vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [], error: undefined }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }

  it('sets Authorization header when password is provided', async () => {
    const fetchSpy = mockFetch()
    const client = createRemoteForgeClient({
      url: 'http://remote:9999',
      password: 'secret',
      fetch: fetchSpy,
    })

    // project.list triggers a GET /project request
    await client.project.list({ directory: '/test' }).catch(() => {})

    expect(fetchSpy).toHaveBeenCalled()
    const [request] = fetchSpy.mock.calls[0] as [Request]
    expect(request.headers.get('Authorization')).toBe(
      buildBasicAuthHeader('opencode', 'secret'),
    )
  })

  it('does not set Authorization header when password is undefined', async () => {
    const fetchSpy = mockFetch()
    const client = createRemoteForgeClient({
      url: 'http://remote:9999',
      fetch: fetchSpy,
    })

    await client.project.list({ directory: '/test' }).catch(() => {})

    expect(fetchSpy).toHaveBeenCalled()
    const [request] = fetchSpy.mock.calls[0] as [Request]
    expect(request.headers.get('Authorization')).toBeNull()
  })

  it('uses the provided base URL as request prefix', async () => {
    const fetchSpy = mockFetch()
    const client = createRemoteForgeClient({
      url: 'http://remote:9999',
      password: 'secret',
      fetch: fetchSpy,
    })

    await client.project.list({ directory: '/test' }).catch(() => {})

    expect(fetchSpy).toHaveBeenCalled()
    const [request] = fetchSpy.mock.calls[0] as [Request]
    expect(request.url).toMatch(/^http:\/\/remote:9999\//)
  })
})
