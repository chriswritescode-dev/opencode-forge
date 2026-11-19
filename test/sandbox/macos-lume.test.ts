import { describe, test, expect } from 'vitest'
import {
  LumeRequestError,
  SPACESD_GUEST_PORT,
  buildLumeRunBody,
  createLumeClient,
  mapLumeVmState,
  spacesdUrlFromDetails,
  type LumeRunBody,
  type LumeVmDetails,
} from '../../src/sandbox/macos-lume'
import type { MacosShare } from '../../src/sandbox/macos-shares'
import type { SandboxState } from '../../src/sandbox/runtime'

interface RecordedCall {
  url: string
  method: string
  body: unknown
  signal: AbortSignal | null
  headers: HeadersInit | undefined
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createClient(
  handler: (call: RecordedCall) => Response | Promise<Response>,
  baseUrl = 'http://127.0.0.1:7777',
) {
  const calls: RecordedCall[] = []
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      body,
      signal: init?.signal ?? null,
      headers: init?.headers,
    }
    calls.push(call)
    return handler(call)
  }
  return { client: createLumeClient({ baseUrl, fetch: fetchImpl }), calls }
}

async function captureError(run: () => Promise<unknown>): Promise<LumeRequestError> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof LumeRequestError)) throw error
    return error
  }
  throw new Error('expected the call to reject with a LumeRequestError')
}

describe('createLumeClient', () => {
  test('getVm parses VM details and forwards from a 200 response', async () => {
    const { client, calls } = createClient(() =>
      jsonResponse({
        name: 'forge-macos',
        status: 'running',
        cpuCount: 4,
        memorySize: 8192,
        forwards: { '3211': 61000 },
        extra: 'ignored',
      }),
    )

    const details = await client.getVm('forge-macos')

    expect(details).toMatchObject({
      name: 'forge-macos',
      status: 'running',
      cpuCount: 4,
      memorySize: 8192,
      forwards: { '3211': 61000 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:7777/lume/vms/forge-macos')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].body).toBeUndefined()
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  test('getVm encodes the VM name in the URL', async () => {
    const { client, calls } = createClient(() => jsonResponse({ name: 'forge macos', status: 'stopped' }))

    await client.getVm('forge macos')

    expect(calls[0].url).toBe('http://127.0.0.1:7777/lume/vms/forge%20macos')
  })

  test('getVm returns null on 404', async () => {
    const { client } = createClient(() => jsonResponse({ message: 'VM not found' }, 404))

    await expect(client.getVm('missing')).resolves.toBeNull()
  })

  test('getVm throws LumeRequestError carrying the server message on 500', async () => {
    const { client } = createClient(() => jsonResponse({ message: 'clone failed hard' }, 500))

    const error = await captureError(() => client.getVm('forge-macos'))

    expect(error).toBeInstanceOf(LumeRequestError)
    expect(error.name).toBe('LumeRequestError')
    expect(error.status).toBe(500)
    expect(error.message).toContain('clone failed hard')
  })

  test('getVm throws LumeRequestError when fetch rejects', async () => {
    const cause = new TypeError('fetch failed')
    const { client } = createClient(() => {
      throw cause
    })

    const error = await captureError(() => client.getVm('forge-macos'))

    expect(error).toBeInstanceOf(LumeRequestError)
    expect(error.status).toBeUndefined()
    expect(error.cause).toBe(cause)
    expect(error.message).toContain('GET')
  })

  test('getVm throws LumeRequestError when fetch rejects with an abort-like error', async () => {
    const cause = new DOMException('This operation was aborted', 'AbortError')
    const { client } = createClient(() => {
      throw cause
    })

    const error = await captureError(() => client.getVm('forge-macos'))

    expect(error).toBeInstanceOf(LumeRequestError)
    expect(error.cause).toBe(cause)
  })

  test('getVm throws LumeRequestError for an invalid JSON payload', async () => {
    const { client } = createClient(() => new Response('not json', { status: 200 }))

    const error = await captureError(() => client.getVm('forge-macos'))

    expect(error).toBeInstanceOf(LumeRequestError)
  })

  test('getVm throws LumeRequestError for a payload that fails validation', async () => {
    const { client } = createClient(() => jsonResponse({ name: '', status: 'running' }))

    const error = await captureError(() => client.getVm('forge-macos'))

    expect(error).toBeInstanceOf(LumeRequestError)
  })

  test('listVms requests the VM list and returns parsed entries', async () => {
    const { client, calls } = createClient(
      () =>
        jsonResponse([
          { name: 'base', status: 'stopped' },
          { name: 'forge-macos', status: 'running', forwards: { '3211': 3211 } },
        ]),
      'http://127.0.0.1:7777/',
    )

    const vms = await client.listVms()

    expect(vms).toHaveLength(2)
    expect(vms[1]).toMatchObject({ name: 'forge-macos', status: 'running', forwards: { '3211': 3211 } })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:7777/lume/vms')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  test('listVms throws LumeRequestError for a non-array payload', async () => {
    const { client } = createClient(() => jsonResponse({ vms: [] }))

    const error = await captureError(() => client.listVms())

    expect(error).toBeInstanceOf(LumeRequestError)
  })

  test('listVms throws LumeRequestError for an invalid entry', async () => {
    const { client } = createClient(() =>
      jsonResponse([
        { name: 'valid', status: 'running' },
        { name: '', status: 'running' },
      ]),
    )

    const error = await captureError(() => client.listVms())

    expect(error).toBeInstanceOf(LumeRequestError)
  })

  test('cloneVm posts the source and target names', async () => {
    const { client, calls } = createClient(() => jsonResponse({ ok: true }, 201))

    await client.cloneVm('base', 'forge-macos')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:7777/lume/vms/clone')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({ name: 'base', newName: 'forge-macos' })
    expect(new Headers(calls[0].headers).get('content-type')).toBe('application/json')
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  test('runVm posts the run body and resolves on 200 and 202', async () => {
    const body = buildLumeRunBody([], '/tmp/forge-gateway.sock')

    for (const status of [200, 202]) {
      const { client, calls } = createClient(() => jsonResponse({ ok: true }, status))

      await expect(client.runVm('forge macos', body)).resolves.toBeUndefined()

      expect(calls[0].url).toBe('http://127.0.0.1:7777/lume/vms/forge%20macos/run')
      expect(calls[0].method).toBe('POST')
      expect(calls[0].body).toEqual(body)
      expect(new Headers(calls[0].headers).get('content-type')).toBe('application/json')
      expect(calls[0].signal).toBeInstanceOf(AbortSignal)
    }
  })

  test('runVm throws LumeRequestError on 400', async () => {
    const { client } = createClient(() => jsonResponse({ message: 'bad run request' }, 400))

    const error = await captureError(() => client.runVm('forge-macos', buildLumeRunBody([], '/tmp/sock')))

    expect(error.status).toBe(400)
    expect(error.message).toContain('bad run request')
  })

  test('stopVm posts to the VM stop endpoint', async () => {
    const { client, calls } = createClient(() => jsonResponse({ ok: true }))

    await client.stopVm('forge-macos')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:7777/lume/vms/forge-macos/stop')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })
})

describe('buildLumeRunBody', () => {
  test('maps one shared directory per share and forwards the spacesd port', () => {
    const shares: MacosShare[] = [
      { hostDir: '/Users/dev/project', guestDir: '/Users/dev/project', readOnly: false, tag: 'forge-aaaaaaaaaaaa' },
      { hostDir: '/Users/dev/output', guestDir: '/Users/dev/output', readOnly: true, tag: 'forge-bbbbbbbbbbbb' },
    ]

    const body = buildLumeRunBody(shares, '/tmp/forge-gateway.sock')

    expect(body).toEqual({
      noDisplay: true,
      vnc: 'disabled',
      network: 'gateway:/tmp/forge-gateway.sock',
      forwards: [SPACESD_GUEST_PORT],
      sharedDirectories: [
        { hostPath: '/Users/dev/project', readOnly: false, tag: 'forge-aaaaaaaaaaaa' },
        { hostPath: '/Users/dev/output', readOnly: true, tag: 'forge-bbbbbbbbbbbb' },
      ],
    })
    expect(body.forwards).toEqual([3211])
  })
})

describe('mapLumeVmState', () => {
  test('maps every VM status combination', () => {
    const cases: Array<[LumeVmDetails | null, SandboxState]> = [
      [null, 'missing'],
      [{ name: 'vm', status: 'running', forwards: { '3211': 3211 } }, 'running'],
      [{ name: 'vm', status: 'RUNNING', forwards: { '3211': 61000 } }, 'running'],
      [{ name: 'vm', status: 'running', forwards: {} }, 'transient'],
      [{ name: 'vm', status: 'running' }, 'transient'],
      [{ name: 'vm', status: 'running', forwards: { '3211': 0 } }, 'transient'],
      [{ name: 'vm', status: 'running', forwards: { '3211': 1.5 } }, 'transient'],
      [{ name: 'vm', status: 'stopped' }, 'stopped'],
      [{ name: 'vm', status: 'Stopped' }, 'stopped'],
      [{ name: 'vm', status: 'provisioning' }, 'transient'],
      [{ name: 'vm', status: 'provisioning (stale)' }, 'transient'],
      [{ name: 'vm', status: 'pulling' }, 'transient'],
      [{ name: 'vm', status: 'pending' }, 'transient'],
      [{ name: 'vm', status: 'crashed' }, 'unknown'],
      [{ name: 'vm', status: 'paused' }, 'unknown'],
    ]

    for (const [details, expected] of cases) {
      expect(mapLumeVmState(details), JSON.stringify(details)).toBe(expected)
    }
  })

  test('running without the spacesd forward is transient, never running', () => {
    const state = mapLumeVmState({ name: 'vm', status: 'running', forwards: { '2222': 2222 } })

    expect(state).toBe('transient')
    expect(state).not.toBe('running')
  })
})

describe('spacesdUrlFromDetails', () => {
  test('returns the loopback URL for a present integer forward', () => {
    expect(spacesdUrlFromDetails({ name: 'vm', status: 'running', forwards: { '3211': 61000 } })).toBe(
      'http://127.0.0.1:61000',
    )
  })

  test('returns null when the forward is absent or unusable', () => {
    expect(spacesdUrlFromDetails(null)).toBeNull()
    expect(spacesdUrlFromDetails({ name: 'vm', status: 'running' })).toBeNull()
    expect(spacesdUrlFromDetails({ name: 'vm', status: 'running', forwards: {} })).toBeNull()
    expect(spacesdUrlFromDetails({ name: 'vm', status: 'running', forwards: { '3211': 0 } })).toBeNull()
    expect(spacesdUrlFromDetails({ name: 'vm', status: 'running', forwards: { '3211': 1.5 } })).toBeNull()
    expect(
      spacesdUrlFromDetails({
        name: 'vm',
        status: 'running',
        forwards: { '3211': '61000' } as unknown as Record<string, number>,
      }),
    ).toBeNull()
  })
})
