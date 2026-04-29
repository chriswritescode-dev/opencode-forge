import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { attachForgeApiServer } from '../../src/api/server'
import { getProjectRegistry } from '../../src/api/project-registry'
import { Database } from 'bun:sqlite'
import { migrations, createApiRegistryRepo } from '../../src/storage'
import type { ToolContext } from '../../src/tools/types'

const TEST_PORT = 35560 + Math.floor(Math.random() * 1000)

function makeCtx(
  projectId: string,
  directory: string,
  host: string,
  port: number,
  db: Database
): ToolContext {
  return {
    projectId,
    directory,
    config: { api: { enabled: true, host, port } },
    db,
    logger: {
      log: () => {},
      debug: () => {},
      error: () => {},
    },
  } as unknown as ToolContext
}

describe('attachForgeApiServer one-port architecture', () => {
  const registry = getProjectRegistry()
  const servers: Array<Awaited<ReturnType<typeof attachForgeApiServer>>> = []
  const originalServe = Bun.serve

  beforeEach(() => {
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

  test('second instance attaches to first public API port', async () => {
    const db1 = new Database(':memory:')
    const db2 = new Database(':memory:')
    for (const migration of migrations) {
      migration.apply(db1)
      migration.apply(db2)
    }

    let serveCalls = 0
    let firstServerPort = 0
    
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = ((opts: any) => {
      serveCalls += 1
      if (serveCalls === 1) {
        // First call - owner server for project A
        return {
          port: opts.port,
          stop: () => {},
        } as ReturnType<typeof Bun.serve>
      } else if (serveCalls === 2) {
        // Second call - public server for project A (coordinator)
        firstServerPort = opts.port
        return {
          port: opts.port,
          stop: () => {},
        } as ReturnType<typeof Bun.serve>
      } else if (serveCalls === 3) {
        // Third call - owner server for project B
        return {
          port: opts.port,
          stop: () => {},
        } as ReturnType<typeof Bun.serve>
      } else {
        // Fourth call - public server for project B throws EADDRINUSE
        throw new Error('EADDRINUSE: address already in use')
      }
    }) as any

    // Mock fetch for registration
    const originalFetch = global.fetch
    global.fetch = (() => Promise.resolve(new Response(JSON.stringify({ registered: true }), { status: 200 }))) as any

    const projectA = makeCtx('project-a', '/tmp/project-a', '127.0.0.1', TEST_PORT, db1)
    const projectB = makeCtx('project-b', '/tmp/project-b', '127.0.0.1', TEST_PORT, db2)
    
    registry.register(projectA)
    registry.register(projectB)

    const server1 = await attachForgeApiServer(projectA, registry)
    expect(server1).not.toBeNull()
    expect(server1!.role).toBe('coordinator')
    expect(server1!.url).toBe(`http://127.0.0.1:${TEST_PORT}`)
    servers.push(server1!)

    const server2 = await attachForgeApiServer(projectB, registry)
    expect(server2).not.toBeNull()
    expect(server2!.role).toBe('attached')
    expect(server2!.url).toBe(`http://127.0.0.1:${TEST_PORT}`)
    servers.push(server2!)

    global.fetch = originalFetch
  })

  test('coordinator lists attached project', async () => {
    const db1 = new Database(':memory:')
    const db2 = new Database(':memory:')
    for (const migration of migrations) {
      migration.apply(db1)
      migration.apply(db2)
    }

    let serveCalls = 0
    
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = ((opts: any) => {
      serveCalls += 1
      if (serveCalls <= 2) {
        // Owner and public server for project A
        return {
          port: opts.port,
          stop: () => {},
        } as ReturnType<typeof Bun.serve>
      } else if (serveCalls === 3) {
        // Owner server for project B
        return {
          port: opts.port,
          stop: () => {},
        } as ReturnType<typeof Bun.serve>
      } else {
        // Public server for project B throws EADDRINUSE
        throw new Error('EADDRINUSE: address already in use')
      }
    }) as any

    // Mock fetch for registration
    const originalFetch = global.fetch
    global.fetch = (() => Promise.resolve(new Response(JSON.stringify({ registered: true }), { status: 200 }))) as any

    const projectA = makeCtx('project-a', '/tmp/project-a', '127.0.0.1', TEST_PORT + 1, db1)
    const projectB = makeCtx('project-b', '/tmp/project-b', '127.0.0.1', TEST_PORT + 1, db2)
    
    registry.register(projectA)
    registry.register(projectB)

    const server1 = await attachForgeApiServer(projectA, registry)
    expect(server1).not.toBeNull()
    servers.push(server1!)

    const server2 = await attachForgeApiServer(projectB, registry)
    expect(server2).not.toBeNull()
    servers.push(server2!)

    // Verify both processes have their instances persisted in their respective DBs
    const repo1 = createApiRegistryRepo(db1)
    const repo2 = createApiRegistryRepo(db2)
    const instances1 = repo1.listProjectInstances()
    const instances2 = repo2.listProjectInstances()
    
    expect(instances1).toHaveLength(1)
    expect(instances1[0].projectId).toBe('project-a')
    expect(instances2).toHaveLength(1)
    expect(instances2[0].projectId).toBe('project-b')

    global.fetch = originalFetch
  })

  test('local attachment keeps public listener alive when coordinator stops', async () => {
    const db1 = new Database(':memory:')
    const db2 = new Database(':memory:')
    for (const migration of migrations) {
      migration.apply(db1)
      migration.apply(db2)
    }

    let ownerStops = 0
    let publicStops = 0

    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = ((opts: any) => {
      return {
        port: opts.port,
        stop: () => {
          if (opts.port === 0) {
            ownerStops += 1
          } else {
            publicStops += 1
          }
        },
      } as ReturnType<typeof Bun.serve>
    }) as any

    const projectA = makeCtx('project-a-transfer', '/tmp/project-a-transfer', '127.0.0.1', TEST_PORT + 3, db1)
    const projectB = makeCtx('project-b-transfer', '/tmp/project-b-transfer', '127.0.0.1', TEST_PORT + 3, db2)

    registry.register(projectA)
    registry.register(projectB)

    const server1 = await attachForgeApiServer(projectA, registry)
    const server2 = await attachForgeApiServer(projectB, registry)
    expect(server1).not.toBeNull()
    expect(server2).not.toBeNull()
    servers.push(server1!, server2!)

    await server1!.stop()

    expect(ownerStops).toBe(1)
    expect(publicStops).toBe(0)

    await server2!.stop()

    expect(ownerStops).toBe(2)
    expect(publicStops).toBe(1)
  })

  test('stop is idempotent and removes leases', async () => {
    const db1 = new Database(':memory:')
    for (const migration of migrations) {
      migration.apply(db1)
    }

    let stopCalls = 0
    
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = ((opts: any) => {
      return {
        port: opts.port,
        stop: () => {
          stopCalls += 1
        },
      } as ReturnType<typeof Bun.serve>
    }) as any

    const projectA = makeCtx('project-a', '/tmp/project-a', '127.0.0.1', TEST_PORT + 2, db1)
    registry.register(projectA)

    const server1 = await attachForgeApiServer(projectA, registry)
    expect(server1).not.toBeNull()
    servers.push(server1!)

    const repo = createApiRegistryRepo(db1)
    const coordinator = repo.getCoordinator('127.0.0.1', TEST_PORT + 2)
    expect(coordinator).toBeTruthy()

    await server1!.stop()
    await server1!.stop() // Second call should be no-op

    // Should stop both owner and public server
    expect(stopCalls).toBe(2)
    
    const coordinatorAfter = repo.getCoordinator('127.0.0.1', TEST_PORT + 2)
    expect(coordinatorAfter).toBeNull()
  })
})
