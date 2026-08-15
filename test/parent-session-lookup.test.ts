import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createParentSessionLookup } from '../src/index'
import type { Logger } from '../src/types'
import { createFakeForgeClient } from './helpers/fake-client'
import { ForgeClientError } from '../src/client/port'
import { ParentLookupUndeterminedError } from '../src/utils/session-ancestry'

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

  test('a session with no parent is definitive absence, not an undetermined lookup', async () => {
    const { client } = createFakeForgeClient({
      session: {
        get: async () => ({ id: 'session-root' }),
      },
    })
    const loop = createMockLoop([])

    const lookup = createParentSessionLookup({ client, directory: '/host', loop: loop as any, logger: mockLogger })

    // A readable root session genuinely has no parent, so it must resolve to null rather than
    // failing closed; otherwise every ordinary top-level session would lose its shell.
    expect(await lookup('session-root')).toBeNull()
  })

  test('an unreadable session rejects instead of reporting "no parent"', async () => {
    const sessionId = 'session-fail'
    let calls = 0
    const { client } = createFakeForgeClient({
      session: {
        get: async () => {
          calls++
          throw new ForgeClientError({ kind: 'not-found', method: 'session.get', message: 'not found' })
        },
      },
    })
    const loop = createMockLoop([])

    const lookup = createParentSessionLookup({ client, directory: '/host', loop: loop as any, logger: mockLogger })

    // Returning null would read as "no parent", which sandbox routing treats as "not a descendant
    // of the sandboxed session" and silently runs the command on the host.
    await expect(lookup(sessionId)).rejects.toBeInstanceOf(ParentLookupUndeterminedError)
    expect(calls).toBe(1)

    // The failure is not cached, so it can never harden into a lasting wrong answer.
    await expect(lookup(sessionId)).rejects.toBeInstanceOf(ParentLookupUndeterminedError)
    expect(calls).toBe(2)
  })

  test('a session that becomes readable resolves on the very next call', async () => {
    const sessionId = 'session-race'
    let calls = 0
    const { client } = createFakeForgeClient({
      session: {
        get: async () => {
          calls++
          if (calls === 1) throw new ForgeClientError({ kind: 'not-found', method: 'session.get', message: 'not found' })
          return { parentID: 'parent-x' }
        },
      },
    })
    const loop = createMockLoop([])

    const lookup = createParentSessionLookup({ client, directory: '/host', loop: loop as any, logger: mockLogger })

    // A sub-agent whose session record is not queryable yet fails closed for that one call only.
    await expect(lookup(sessionId)).rejects.toBeInstanceOf(ParentLookupUndeterminedError)
    expect(await lookup(sessionId)).toBe('parent-x')
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
    })

    const result = await lookup(sessionId)
    expect(result).toBe(parentId)
    expect(callOrder).toEqual([`dir:${worktreeDir}`])
  })
})
