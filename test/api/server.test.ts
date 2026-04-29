import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { attachForgeApiServer } from '../../src/api/server'
import { getProjectRegistry } from '../../src/api/project-registry'
import type { ToolContext } from '../../src/tools/types'
import { Database } from 'bun:sqlite'
import { migrations, createApiRegistryRepo } from '../../src/storage'

function makeCtx(
  projectId: string,
  host: string,
  port: number,
  errors: string[],
  logs: string[] = []
): ToolContext {
  const db = new Database(':memory:')
  for (const migration of migrations) {
    migration.apply(db)
  }
  
  return {
    projectId,
    directory: `/tmp/${projectId}`,
    config: { api: { enabled: true, host, port } },
    db,
    logger: {
      log: (message: string) => logs.push(message),
      debug: () => {},
      error: (message: string) => {
        errors.push(message)
      },
    },
  } as unknown as ToolContext
}

describe('attachForgeApiServer', () => {
  const registry = getProjectRegistry()
  const originalServe = Bun.serve
  const servers: Array<{ stop: () => Promise<void> }> = []

  beforeEach(() => {
    for (const ctx of registry.list()) {
      registry.unregister(ctx.projectId)
    }
    servers.length = 0
  })

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()
      if (server) {
        await server.stop()
      }
    }
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = originalServe
    for (const ctx of registry.list()) {
      registry.unregister(ctx.projectId)
    }
  })

  test('starts coordinator when public port is available', async () => {
    let serveCalls = 0
    let stopCalls = 0
    const serveResults: Array<{ hostname: string; port: number }> = []
    
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = mock((opts: any) => {
      serveCalls += 1
      serveResults.push({ hostname: opts.hostname, port: opts.port })
      return {
        port: opts.port,
        stop: () => {
          stopCalls += 1
        },
      } as ReturnType<typeof Bun.serve>
    })

    const errors: string[] = []
    const logs: string[] = []
    const ctx = makeCtx('project-a', '127.0.0.1', 35552, errors, logs)
    registry.register(ctx)

    const server = await attachForgeApiServer(ctx, registry)
    expect(server).not.toBeNull()
    expect(server!.role).toBe('coordinator')
    expect(serveCalls).toBe(2) // owner server + public server
    expect(serveResults[0].hostname).toBe('127.0.0.1')
    expect(serveResults[0].port).toBe(0) // owner server uses port 0
    expect(serveResults[1].hostname).toBe('127.0.0.1')
    expect(serveResults[1].port).toBe(35552)

    if (server) servers.push(server)

    await server?.stop()
    expect(stopCalls).toBe(2) // stops both public and owner servers
    expect(logs.some((msg) => msg.includes('[api] stopped'))).toBe(true)
  })

  test('attaches when public port is already in use', async () => {
    let serveCalls = 0
    const errors: string[] = []
    const logs: string[] = []
    
    // Mock global fetch for registration
    const originalFetch = global.fetch
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ registered: true }), { status: 200 }))) as any

    let firstCall = true
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = mock((opts: any) => {
      serveCalls += 1
      if (firstCall) {
        // First call - owner server
        firstCall = false
        return {
          port: opts.port,
          stop: () => {},
        } as ReturnType<typeof Bun.serve>
      } else {
        // Second call - public server throws Bun's port-in-use message
        throw new Error('Failed to start server. Is port 35553 in use?')
      }
    })

    const ctx = makeCtx('project-a', '127.0.0.1', 35553, errors, logs)
    registry.register(ctx)

    const server = await attachForgeApiServer(ctx, registry)
    expect(server).not.toBeNull()
    expect(server!.role).toBe('attached')
    expect(server!.url).toBe('http://127.0.0.1:35553')
    expect(errors.some((msg) => msg.includes('failed to bind'))).toBe(false)
    expect(logs.some((msg) => msg.includes('attached to existing listener'))).toBe(true)

    if (server) servers.push(server)

    global.fetch = originalFetch
  })

  test('returns null and cleans owner endpoint for non-EADDRINUSE bind failures', async () => {
    let ownerServerStopped = false
    const errors: string[] = []
    
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = mock((opts: any) => {
      if (opts.port === 0) {
        // Owner server succeeds
        return {
          port: 0,
          stop: () => {
            ownerServerStopped = true
          },
        } as ReturnType<typeof Bun.serve>
      } else {
        // Public server fails with non-EADDRINUSE error
        throw new Error('permission denied')
      }
    })

    const ctx = makeCtx('project-a', '127.0.0.1', 35554, errors)
    registry.register(ctx)

    const server = await attachForgeApiServer(ctx, registry)
    expect(server).toBeNull()
    expect(ownerServerStopped).toBe(true)
    expect(errors.some((msg) => msg.includes('failed to bind'))).toBe(true)
  })

  test('stop is idempotent', async () => {
    let stopCalls = 0
    let callCount = 0
    
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = mock((opts: any) => {
      callCount += 1
      return {
        port: callCount === 1 ? 0 : 35555,
        stop: () => {
          stopCalls += 1
        },
      } as ReturnType<typeof Bun.serve>
    })

    const errors: string[] = []
    const ctx = makeCtx('project-a', '127.0.0.1', 35555, errors)
    registry.register(ctx)

    const server = await attachForgeApiServer(ctx, registry)
    expect(server).not.toBeNull()

    if (server) {
      await server.stop()
      await server.stop() // Second call should be no-op
    }

    // Should stop both owner and public server (2 stops total)
    expect(stopCalls).toBe(2)
  })
})
