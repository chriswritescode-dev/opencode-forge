import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { openForgeDatabase, closeDatabase } from '../../src/storage/database'
import { resolveDashboardDbPath, startDashboardServer, type DashboardServerHandle } from '../../src/dashboard/launch'

const MOCK_PORT = 18_472

// Bun global is not available under Vitest/Node.
// Mock Bun.serve to capture the handler and route fetch through it.
beforeAll(() => {
  let currentFetch: ((req: Request) => Response | Promise<Response>) | null = null

  ;(globalThis as any).Bun = {
    serve: (config: { fetch: (req: Request) => Response | Promise<Response> }) => {
      currentFetch = config.fetch
      return { port: MOCK_PORT, stop: vi.fn() }
    },
    spawn: vi.fn(),
  } as any

  const originalFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, ...rest) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    if (urlStr.startsWith(`http://localhost:${MOCK_PORT}`) && currentFetch) {
      const req = new Request(urlStr, rest[0])
      return Promise.resolve(currentFetch(req))
    }
    return originalFetch(url, ...rest)
  })
})

afterAll(() => {
  delete (globalThis as any).Bun
  vi.restoreAllMocks()
})

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

describe('startDashboardServer', () => {
  let dbPath: string
  let handle: DashboardServerHandle | null = null

  beforeEach(() => {
    const rand = Math.random().toString(36).slice(2, 10)
    dbPath = `/tmp/forge-dashboard-launch-test-${rand}.db`
    const db = openForgeDatabase(dbPath)
    closeDatabase(db)
  })

  afterEach(() => {
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

    const res = await fetch(handle.url)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/^<!DOCTYPE html>/)
  })

  test('serves the data api as json', async () => {
    handle = startDashboardServer({ dbPath, port: 0 })
    const res = await fetch(`${handle.url}/api/data`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = await res.json()
    expect(body).toHaveProperty('projects')
    expect(body).toHaveProperty('totals')
  })
})
