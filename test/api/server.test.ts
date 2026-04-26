import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { attachForgeApiServer } from '../../src/api/server'
import { getProjectRegistry } from '../../src/api/project-registry'
import type { ToolContext } from '../../src/tools/types'

function makeCtx(
  projectId: string,
  host: string,
  port: number,
  errors: string[]
): ToolContext {
  return {
    projectId,
    directory: `/tmp/${projectId}`,
    config: { api: { enabled: true, host, port } },
    logger: {
      log: () => {},
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

  test('reuses listener for same host and port with ref counting', async () => {
    let serveCalls = 0
    let stopCalls = 0
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = mock(() => {
      serveCalls += 1
      return {
        stop: () => {
          stopCalls += 1
        },
      } as ReturnType<typeof Bun.serve>
    })

    const errors: string[] = []
    const a = makeCtx('project-a', '127.0.0.1', 35552, errors)
    const b = makeCtx('project-b', '127.0.0.1', 35552, errors)
    registry.register(a)
    registry.register(b)

    const serverA = attachForgeApiServer(a, registry)
    const serverB = attachForgeApiServer(b, registry)

    expect(serverA).not.toBeNull()
    expect(serverB).not.toBeNull()
    expect(serveCalls).toBe(1)

    if (serverA) servers.push(serverA)
    if (serverB) servers.push(serverB)

    await serverB?.stop()
    expect(stopCalls).toBe(0)

    await serverA?.stop()
    expect(stopCalls).toBe(1)
  })

  test('returns null when Bun.serve bind fails', () => {
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = mock(() => {
      throw new Error('EADDRINUSE: address already in use')
    })

    const errors: string[] = []
    const ctx = makeCtx('project-a', '127.0.0.1', 35553, errors)
    registry.register(ctx)

    const server = attachForgeApiServer(ctx, registry)
    expect(server).toBeNull()
    expect(errors.some((msg) => msg.includes('failed to bind 127.0.0.1:35553'))).toBe(true)
  })

  test('returns null on host or port mismatch while existing listener remains', async () => {
    let stopCalls = 0
    ;(Bun as unknown as { serve: typeof Bun.serve }).serve = mock(() => {
      return {
        stop: () => {
          stopCalls += 1
        },
      } as ReturnType<typeof Bun.serve>
    })

    const errors: string[] = []
    const a = makeCtx('project-a', '127.0.0.1', 35554, errors)
    const b = makeCtx('project-b', '127.0.0.1', 35555, errors)
    registry.register(a)
    registry.register(b)

    const serverA = attachForgeApiServer(a, registry)
    const serverB = attachForgeApiServer(b, registry)
    expect(serverA).not.toBeNull()
    expect(serverB).toBeNull()
    expect(errors.some((msg) => msg.includes('existing listener on 127.0.0.1:35554'))).toBe(true)

    if (serverA) {
      await serverA.stop()
    }
    expect(stopCalls).toBe(1)
  })
})
