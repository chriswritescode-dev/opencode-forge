import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createParentSessionLookup, type CreateParentSessionLookupOptions } from '../src/index'
import type { Logger } from '../src/types'

const mockLogger: Logger = {
  log: () => {},
  debug: () => {},
  error: () => {},
}

function createMockV2Client(responses: Map<string, { data?: { parentID?: string | null }; error?: unknown }>) {
  return {
    session: {
      get: async (input: { sessionID: string; directory?: string }) => {
        const key = input.directory ? `${input.sessionID}:${input.directory}` : input.sessionID
        const response = responses.get(key) ?? responses.get(input.sessionID)
        if (!response) {
          throw new Error(`No mock response for ${key}`)
        }
        return response
      },
    },
  }
}

function createMockLoopService(activeLoops: Array<{ loopName: string; worktreeDir: string }>) {
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
    const v2 = createMockV2Client(
      new Map([[sessionId, { data: { parentID: parentId } }]]),
    )
    const loopService = createMockLoopService([])

    const lookup = createParentSessionLookup({
      v2,
      directory: '/host',
      loopService: loopService as any,
      logger: mockLogger,
    })

    const result1 = await lookup(sessionId)
    expect(result1).toBe(parentId)

    const result2 = await lookup(sessionId)
    expect(result2).toBe(parentId)
  })

  test('negative result is cached for TTL then retried', async () => {
    const sessionId = 'session-fail'
    const parentId = 'parent-success'
    let callCount = 0

    const v2 = createMockV2Client(
      new Map([
        [
          sessionId,
          {
            data: undefined,
            error: 'not found',
          },
        ],
      ]),
    )
    const loopService = createMockLoopService([])

    const lookup = createParentSessionLookup({
      v2,
      directory: '/host',
      loopService: loopService as any,
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
    const parentId = 'parent-y'
    let failCount = 0

    const v2 = createMockV2Client(
      new Map([
        [
          sessionId,
          {
            data: undefined,
            error: 'not found',
          },
        ],
      ]),
    )
    const loopService = createMockLoopService([])

    const lookup = createParentSessionLookup({
      v2,
      directory: '/host',
      loopService: loopService as any,
      logger: mockLogger,
      negativeTtlMs: 50,
    })

    const result1 = await lookup(sessionId)
    expect(result1).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 60))
  })

  test('listActive dirs contribute attempts in order', async () => {
    const sessionId = 'session-dir-test'
    const parentId = 'parent-from-worktree'
    const worktreeDir = '/worktree'

    const callOrder: string[] = []
    const v2 = {
      session: {
        get: async (input: { sessionID: string; directory?: string }) => {
          const label = input.directory ? `dir:${input.directory}` : 'no-dir'
          callOrder.push(label)
          if (input.directory === worktreeDir) {
            return { data: { parentID: parentId } }
          }
          return { data: undefined }
        },
      },
    }

    const loopService = createMockLoopService([{ loopName: 'test-loop', worktreeDir }])

    const lookup = createParentSessionLookup({
      v2: v2 as any,
      directory: '/host',
      loopService: loopService as any,
      logger: mockLogger,
      negativeTtlMs: 10,
    })

    const result = await lookup(sessionId)
    expect(result).toBe(parentId)
    expect(callOrder[0]).toBe('no-dir')
    expect(callOrder[callOrder.length - 1]).toBe(`dir:${worktreeDir}`)
  })
})