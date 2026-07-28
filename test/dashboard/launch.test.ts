import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { openForgeDatabase, closeDatabase } from '../../src/storage/database'
import { resolveDashboardDbPath, startDashboardServer, type DashboardServerHandle } from '../../src/dashboard/launch'

describe('resolveDashboardDbPath', () => {
  const originalForgeDb = process.env.FORGE_DB

  afterEach(() => {
    if (originalForgeDb === undefined) delete process.env.FORGE_DB
    else process.env.FORGE_DB = originalForgeDb
  })

  test('prefers explicit path over env var', () => {
    process.env.FORGE_DB = '/tmp/from-env.db'
    expect(resolveDashboardDbPath('/tmp/explicit.db')).toBe('/tmp/explicit.db')
  })

  test('falls back to FORGE_DB env var when no explicit path', () => {
    process.env.FORGE_DB = '/tmp/from-env.db'
    expect(resolveDashboardDbPath()).toBe('/tmp/from-env.db')
  })

  test('resolves under the forge data dir by default', () => {
    delete process.env.FORGE_DB
    expect(resolveDashboardDbPath()).toMatch(/opencode\/forge\/forge\.db$/)
  })
})

/** Port the mocked `Bun.serve` reports for an ephemeral (`port: 0`) request, mirroring an OS assignment. */
const OS_ASSIGNED_PORT = 51234

describe('startDashboardServer', () => {
  let dbPath: string
  let handle: DashboardServerHandle | null = null
  let capturedFetch: (req: Request) => Response | Promise<Response>
  let capturedHostname: string | undefined

  beforeEach(() => {
    const rand = Math.random().toString(36).slice(2, 10)
    dbPath = `/tmp/forge-dashboard-launch-test-${rand}.db`
    const db = openForgeDatabase(dbPath)
    closeDatabase(db)
    capturedHostname = undefined
    vi.stubGlobal('Bun', {
      serve: (opts: { hostname?: string; port?: number; fetch: (req: Request) => Response | Promise<Response> }) => {
        capturedHostname = opts.hostname
        capturedFetch = opts.fetch
        return { port: opts.port === 0 ? OS_ASSIGNED_PORT : opts.port, stop: vi.fn() }
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (handle) {
      handle.stop()
      handle = null
    }
  })

  test('throws when the database does not exist', () => {
    expect(() => startDashboardServer({ dbPath: '/tmp/does-not-exist-forge.db' })).toThrow(
      /Forge database not found/
    )
  })

  test('starts a server and serves the dashboard html', async () => {
    handle = startDashboardServer({ dbPath, port: 0 })
    expect(handle.url).toMatch(/^http:\/\/localhost:\d+$/)

    const res = await capturedFetch(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/^<!DOCTYPE html>/)
  })

  test('serves the data api as json', async () => {
    handle = startDashboardServer({ dbPath, port: 0 })
    const res = await capturedFetch(new Request('http://localhost/api/data'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = await res.json()
    expect(body).toHaveProperty('projects')
    expect(body).toHaveProperty('generatedAt')
  })

  test('default bind is unchanged: localhost, url === localUrl, not exposed', () => {
    handle = startDashboardServer({ dbPath })
    expect(capturedHostname).toBe('localhost')
    expect(handle.host).toBe('localhost')
    expect(handle.url).toBe(handle.localUrl)
    expect(handle.url).toMatch(/^http:\/\/localhost:\d+$/)
    expect(handle.exposed).toBe(false)
  })

  test('explicit host option binds that host', () => {
    handle = startDashboardServer({ dbPath, host: '0.0.0.0', port: 0 })
    expect(capturedHostname).toBe('0.0.0.0')
    expect(handle.exposed).toBe(true)
    expect(handle.localUrl).toBe(`http://localhost:${OS_ASSIGNED_PORT}`)
  })

  test('port 0 reports the OS-assigned port, not the requested 0', () => {
    handle = startDashboardServer({ dbPath, port: 0 })
    expect(handle.port).toBe(OS_ASSIGNED_PORT)
    expect(handle.url).toBe(`http://localhost:${OS_ASSIGNED_PORT}`)
  })

  test('config supplies host and port', () => {
    handle = startDashboardServer({ dbPath, config: { dashboard: { host: '0.0.0.0', port: 5123 } } })
    expect(capturedHostname).toBe('0.0.0.0')
    expect(handle.port).toBe(5123)
  })

  test('explicit options win over config', () => {
    handle = startDashboardServer({
      dbPath,
      host: '127.0.0.1',
      port: 5999,
      config: { dashboard: { host: '0.0.0.0', port: 5123 } },
    })
    expect(capturedHostname).toBe('127.0.0.1')
    expect(handle.port).toBe(5999)
    expect(handle.exposed).toBe(false)
  })

  test('invalid config port falls back to the default and is reported on the handle', () => {
    handle = startDashboardServer({ dbPath, config: { dashboard: { port: -1 } } })
    expect(handle.port).toBe(4747)
    expect(handle.warnings).toEqual([
      'Ignoring dashboard.port -1: expected an integer between 0 and 65535.',
    ])
  })

  test('a usable bind reports no warnings', () => {
    handle = startDashboardServer({ dbPath })
    expect(handle.warnings).toEqual([])
  })

  test('config.dataDir resolves the database when no dbPath or dataDir option is given', () => {
    const originalForgeDb = process.env.FORGE_DB
    delete process.env.FORGE_DB
    try {
      expect(() => startDashboardServer({ config: { dataDir: '/tmp/forge-config-datadir' } })).toThrow(
        /\/tmp\/forge-config-datadir\/forge\.db/
      )
    } finally {
      if (originalForgeDb !== undefined) process.env.FORGE_DB = originalForgeDb
    }
  })

  test('an explicit dataDir option wins over config.dataDir', () => {
    const originalForgeDb = process.env.FORGE_DB
    delete process.env.FORGE_DB
    try {
      expect(() =>
        startDashboardServer({
          dataDir: '/tmp/forge-option-datadir',
          config: { dataDir: '/tmp/forge-config-datadir' },
        })
      ).toThrow(/\/tmp\/forge-option-datadir\/forge\.db/)
    } finally {
      if (originalForgeDb !== undefined) process.env.FORGE_DB = originalForgeDb
    }
  })

  test('concrete non-loopback host is flagged exposed with no separate local url', () => {
    handle = startDashboardServer({ dbPath, host: '192.168.1.20' })
    expect(handle.exposed).toBe(true)
    expect(handle.url).toBe(handle.localUrl)
    expect(handle.url).toBe('http://192.168.1.20:4747')
  })

  test('handler still serves after a non-default bind', async () => {
    handle = startDashboardServer({ dbPath, host: '0.0.0.0', port: 0 })
    const res = await capturedFetch(new Request('http://localhost/api/data'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
  })
})
