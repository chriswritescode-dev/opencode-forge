import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from '../../src/types'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

vi.mock('../../src/storage', () => ({
  initializeDatabase: vi.fn().mockReturnValue({}),
  resolveDataDir: vi.fn().mockReturnValue('/tmp/test'),
  closeDatabase: vi.fn(),
  createLoopsRepo: vi.fn().mockReturnValue({}),
  createPlansRepo: vi.fn().mockReturnValue({}),
  createReviewFindingsRepo: vi.fn().mockReturnValue({}),
  createSectionPlansRepo: vi.fn().mockReturnValue({}),
  resolveLogPath: vi.fn().mockReturnValue('/tmp/test.log'),
}))

const { createParentSessionLookup, createSessionDirectoryLookup } = await import('../../src/index')

function createMockLogger() {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }
}

function createMockV2Client(responses: Map<string, { data?: unknown; error?: unknown }>) {
  return {
    session: {
      get: async (input: Record<string, unknown>) => {
        const key = input.directory
          ? `${input.sessionID}:${input.directory}${input.workspace ? `:${input.workspace}` : ''}`
          : input.workspace
            ? `${input.sessionID}:${input.workspace}`
            : String(input.sessionID)
        const response = responses.get(key) ?? responses.get(String(input.sessionID))
        if (!response) {
          throw new Error(`No mock response for ${key}`)
        }
        return response
      },
    },
  }
}

function createMockLoopService(activeLoops: Array<{ loopName: string; worktreeDir: string; workspaceId?: string }>) {
  return {
    listActive: () => activeLoops.map((l) => ({
      ...l,
      active: true,
      sandbox: false,
      worktree: true,
      sessionId: '',
      startedAt: '',
      iteration: 0,
      maxIterations: 0,
      phase: 'coding' as const,
    })),
    resolveLoopName: () => null,
    getActiveState: () => null,
  }
}

describe('createParentSessionLookup', () => {
  it('with one active loop having workspaceId, issues directory+workspace then workspace-only', async () => {
    const sessionId = 'ses-1'
    const v2 = {
      session: {
        get: vi.fn().mockResolvedValue({ data: undefined }),
      },
    }

    const loopService = createMockLoopService([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])

    const lookup = createParentSessionLookup({
      v2: v2 as any,
      directory: '/host',
      loopService: loopService as any,
      logger: createMockLogger() as any,
      negativeTtlMs: 50,
    })

    await lookup(sessionId)

    const calls = v2.session.get.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      sessionID: sessionId,
      directory: '/wt',
      workspace: 'wrk_x',
    })
    expect(calls[1]).toEqual({
      sessionID: sessionId,
      workspace: 'wrk_x',
    })
  })

  it('no-dir attempt is not issued when there are active loops with workspace', async () => {
    const sessionId = 'ses-2'
    const v2 = {
      session: {
        get: vi.fn().mockResolvedValue({ data: undefined }),
      },
    }

    const loopService = createMockLoopService([
      { loopName: 'loop-1', worktreeDir: '/wt-1', workspaceId: 'wrk_1' },
      { loopName: 'loop-2', worktreeDir: '/wt-2', workspaceId: 'wrk_2' },
    ])

    const lookup = createParentSessionLookup({
      v2: v2 as any,
      directory: '/host',
      loopService: loopService as any,
      logger: createMockLogger() as any,
      negativeTtlMs: 50,
    })

    await lookup(sessionId)

    const calls = v2.session.get.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>)
    for (const call of calls) {
      expect(call).toHaveProperty('sessionID')
      expect(call.sessionID).toBe(sessionId)
      // Should not have a no-dir attempt
      if (call.directory) {
        expect(call.directory).not.toBeUndefined()
      }
    }
  })

  it('failure is logged once per sessionId within negative-TTL window', async () => {
    const sessionId = 'ses-3'
    const v2 = {
      session: {
        get: vi.fn().mockResolvedValue({ data: undefined }),
      },
    }

    const loopService = createMockLoopService([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])
    const logger = createMockLogger()

    const lookup = createParentSessionLookup({
      v2: v2 as any,
      directory: '/host',
      loopService: loopService as any,
      logger: logger as any,
      negativeTtlMs: 1000,
    })

    await lookup(sessionId)
    await lookup(sessionId)
    await lookup(sessionId)

    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining(`[session-resolver] session.get failed for ${sessionId}`)
    )
  })

  it('positive cache prevents re-fetch', async () => {
    const sessionId = 'ses-4'
    const v2 = {
      session: {
        get: vi.fn().mockResolvedValue({ data: { parentID: 'parent-4' } }),
      },
    }

    const loopService = createMockLoopService([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])

    const lookup = createParentSessionLookup({
      v2: v2 as any,
      directory: '/host',
      loopService: loopService as any,
      logger: createMockLogger() as any,
      negativeTtlMs: 50,
    })

    const result1 = await lookup(sessionId)
    expect(result1).toBe('parent-4')

    const result2 = await lookup(sessionId)
    expect(result2).toBe('parent-4')

    expect(v2.session.get).toHaveBeenCalledTimes(1)
  })

  it('no active loops fallback to host directory', async () => {
    const sessionId = 'ses-host'
    const v2 = {
      session: {
        get: vi.fn().mockResolvedValue({ data: { parentID: 'parent-host' } }),
      },
    }

    const loopService = createMockLoopService([])

    const lookup = createParentSessionLookup({
      v2: v2 as any,
      directory: '/host',
      loopService: loopService as any,
      logger: createMockLogger() as any,
      negativeTtlMs: 50,
    })

    const result = await lookup(sessionId)
    expect(result).toBe('parent-host')

    const calls = v2.session.get.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      sessionID: sessionId,
      directory: '/host',
    })
  })

  it('active loop without workspaceId issues only directory attempt', async () => {
    const sessionId = 'ses-nows'
    const v2 = {
      session: {
        get: vi.fn().mockResolvedValue({ data: undefined }),
      },
    }

    const loopService = createMockLoopService([
      { loopName: 'test-loop', worktreeDir: '/wt' },
    ])

    const lookup = createParentSessionLookup({
      v2: v2 as any,
      directory: '/host',
      loopService: loopService as any,
      logger: createMockLogger() as any,
      negativeTtlMs: 50,
    })

    await lookup(sessionId)

    const calls = v2.session.get.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      sessionID: sessionId,
      directory: '/wt',
    })
  })

  it('negative cache TTL is 15s by default', async () => {
    const sessionId = 'ses-ttl'
    const v2 = {
      session: {
        get: vi.fn().mockResolvedValue({ data: undefined }),
      },
    }

    const loopService = createMockLoopService([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])
    const logger = createMockLogger()

    const originalNow = Date.now
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    try {
      const lookup = createParentSessionLookup({
        v2: v2 as any,
        directory: '/host',
        loopService: loopService as any,
        logger: logger as any,
      })

      // First call: sets negative cache entry at 1000 + 15000 = 16000
      // 2 attempts: loop:/wt (workspace) and loop-ws:test-loop
      await lookup(sessionId)
      expect(v2.session.get).toHaveBeenCalledTimes(2)

      // Second call within TTL (now still 1000): returns null without re-attempting
      await lookup(sessionId)
      expect(v2.session.get).toHaveBeenCalledTimes(2) // no additional calls

      // Third call after TTL expires (now = 17000 > 16000): re-attempts
      now = 17000
      await lookup(sessionId)
      expect(v2.session.get).toHaveBeenCalledTimes(4) // 2 more calls
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('no log noise on zero-attempt empty path', async () => {
    const sessionId = 'ses-no-log'
    const v2 = {
      session: {
        get: vi.fn().mockResolvedValue({ data: undefined }),
      },
    }

    // Active loop with empty worktreeDir (so it's skipped)
    const loopService = createMockLoopService([
      { loopName: 'test-loop', worktreeDir: '' },
    ])
    const logger = createMockLogger()

    const lookup = createParentSessionLookup({
      v2: v2 as any,
      directory: '/host',
      loopService: loopService as any,
      logger: logger as any,
      negativeTtlMs: 50,
    })

    const result = await lookup(sessionId)
    expect(result).toBeNull()
    // No attempts were made, so session.get should not be called
    expect(v2.session.get).not.toHaveBeenCalled()
    // Logger should NOT be called with failure message (failures.length === 0)
    expect(logger.log).not.toHaveBeenCalledWith(
      expect.stringContaining('[session-resolver] session.get failed'),
    )
  })
})

describe('createSessionDirectoryLookup', () => {
  it('with workspaceId, includes workspace in attempts', async () => {
    const sessionId = 'ses-5'
    const v2 = {
      session: {
        get: vi.fn()
          .mockResolvedValueOnce({ data: undefined })
          .mockResolvedValueOnce({ data: { directory: '/wt' } }),
      },
    }

    const loopService = createMockLoopService([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])

    const lookup = createSessionDirectoryLookup({
      v2: v2 as any,
      directory: '/host',
      loopService: loopService as any,
    })

    await lookup(sessionId)

    const calls = v2.session.get.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      sessionID: sessionId,
      directory: '/wt',
      workspace: 'wrk_x',
    })
    expect(calls[1]).toEqual({
      sessionID: sessionId,
      workspace: 'wrk_x',
    })
  })

  it('positive result is cached', async () => {
    const sessionId = 'ses-6'
    const v2 = {
      session: {
        get: vi.fn().mockResolvedValue({ data: { directory: '/wt' } }),
      },
    }

    const loopService = createMockLoopService([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])

    const lookup = createSessionDirectoryLookup({
      v2: v2 as any,
      directory: '/host',
      loopService: loopService as any,
    })

    const result1 = await lookup(sessionId)
    expect(result1).toBe('/wt')

    const result2 = await lookup(sessionId)
    expect(result2).toBe('/wt')

    expect(v2.session.get).toHaveBeenCalledTimes(1)
  })
})
