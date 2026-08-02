import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createParentSessionLookup } from '../src/index'
import type { Logger } from '../src/types'
import { createFakeForgeClient } from './helpers/fake-client'
import { ForgeClientError } from '../src/client/port'

const mockLogger: Logger = {
  log: () => {},
  debug: () => {},
  error: () => {},
}

function createMockLoop(activeLoops: Array<{ loopName: string; worktreeDir: string }>) {
  return {
    listActive: () => activeLoops.map((l) => ({ ...l, active: true, sandbox: false, sessionId: '', startedAt: '', iteration: 0, maxIterations: 0, phase: 'coding' as const, audit: false, errorCount: 0, auditCount: 0, worktree: false })),
    resolveLoopName: () => null,
    getActiveState: () => null,
  }
}

describe('createParentSessionLookup', () => {
  test('positive lookup caches the parent ID across calls', async () => {
    const sessionId = 'session-123'
    const parentId = 'parent-x'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => ({ parentID: parentId }),
      },
    })
    const loop = createMockLoop([])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loop as any,
      logger: mockLogger,
    })

    const result1 = await lookup(sessionId)
    expect(result1).toBe(parentId)

    const result2 = await lookup(sessionId)
    expect(result2).toBe(parentId)
  })

  test('negative result is cached for TTL then retried', async () => {
    const sessionId = 'session-fail'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => { throw new ForgeClientError({ kind: 'not-found', method: 'session.get', message: 'not found' }) },
      },
    })
    const loop = createMockLoop([])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loop as any,
      logger: mockLogger,
      negativeTtlMs: 100,
    })

    const result1 = await lookup(sessionId)
    expect(result1).toBeNull()

    const result2 = await lookup(sessionId)
    expect(result2).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 150))

    const result3 = await lookup(sessionId)
    expect(result3).toBeNull()
  })

  test('first call fails, second call succeeds after TTL expiry', async () => {
    const sessionId = 'session-mixed'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => { throw new ForgeClientError({ kind: 'not-found', method: 'session.get', message: 'not found' }) },
      },
    })
    const loop = createMockLoop([])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loop as any,
      logger: mockLogger,
      negativeTtlMs: 50,
    })

    const result1 = await lookup(sessionId)
    expect(result1).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 60))
  })

  test('transient session.get failures propagate instead of being cached as absence', async () => {
    const sessionId = 'session-transient'
    const transient = new ForgeClientError({ kind: 'connection', method: 'session.get', message: 'Unable to connect' })
    const { client } = createFakeForgeClient({
      session: {
        get: async () => { throw transient },
      },
    })
    const loop = createMockLoop([])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loop as any,
      logger: mockLogger,
      negativeTtlMs: 1000,
    })

    // A transient failure is not a definitive absence: it must reject so sandbox routing
    // fails closed rather than caching a false "no parent" for the negative TTL.
    await expect(lookup(sessionId)).rejects.toThrow(/Unable to connect/)
    await expect(lookup(sessionId)).rejects.toThrow(/Unable to connect/)
  })

  test('transient failure is not negative-cached: recovery resolves once the host recovers', async () => {
    const sessionId = 'session-recover'
    let calls = 0
    const { client } = createFakeForgeClient({
      session: {
        get: async () => {
          calls++
          if (calls === 1) throw new ForgeClientError({ kind: 'unavailable', method: 'session.get', message: 'host unavailable' })
          return { parentID: 'parent-x' }
        },
      },
    })
    const loop = createMockLoop([])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loop as any,
      logger: mockLogger,
      negativeTtlMs: 100000,
    })

    await expect(lookup(sessionId)).rejects.toThrow(/host unavailable/)
    // The failed attempt was not negative-cached, so the very next call retries and succeeds.
    expect(await lookup(sessionId)).toBe('parent-x')
  })

  test('listActive dirs contribute attempts in order', async () => {
    const sessionId = 'session-dir-test'
    const parentId = 'parent-from-worktree'
    const worktreeDir = '/worktree'

    const callOrder: string[] = []
    const { client } = createFakeForgeClient({
      session: {
        get: async (input: any) => {
          const label = input.directory ? `dir:${input.directory}` : 'no-dir'
          callOrder.push(label)
          if (input.directory === worktreeDir) {
            return { parentID: parentId }
          }
          throw new ForgeClientError({ kind: 'not-found', method: 'session.get', message: 'not found' })
        },
      },
    })

    const loop = createMockLoop([{ loopName: 'test-loop', worktreeDir }])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loop as any,
      logger: mockLogger,
      negativeTtlMs: 10,
    })

    const result = await lookup(sessionId)
    expect(result).toBe(parentId)
    expect(callOrder).toEqual([`dir:${worktreeDir}`])
  })
})
