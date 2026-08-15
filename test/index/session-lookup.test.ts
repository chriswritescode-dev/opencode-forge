import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { ForgeClientError } from '../../src/client/port'

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
const { ParentLookupUndeterminedError } = await import('../../src/utils/session-ancestry')

function createMockLogger() {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }
}

function createMockLoop(activeLoops: Array<{ loopName: string; worktreeDir: string; workspaceId?: string }>) {
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
  }
}

const notFoundErr = () => new ForgeClientError({ kind: 'not-found', method: 'session.get', message: 'not found' })

describe('createParentSessionLookup', () => {
  it('with one active loop having workspaceId, issues directory+workspace then workspace-only then host fallback', async () => {
    const sessionId = 'ses-1'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => { throw notFoundErr() },
      },
    })

    const loopService = createMockLoop([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loopService as any,
      logger: createMockLogger() as any,
    })

    await expect(lookup(sessionId)).rejects.toBeInstanceOf(ParentLookupUndeterminedError)

    const calls = ((client.session.get as any).mock.calls as unknown[][]).map((c: unknown[]) => c[0] as Record<string, unknown>)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({
      sessionID: sessionId,
      directory: '/wt',
      workspace: 'wrk_x',
    })
    expect(calls[1]).toEqual({
      sessionID: sessionId,
      workspace: 'wrk_x',
    })
    expect(calls[2]).toEqual({
      sessionID: sessionId,
      directory: '/host',
    })
  })

  it('host fallback is attempted after active loop attempts', async () => {
    const sessionId = 'ses-2'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => { throw notFoundErr() },
      },
    })

    const loopService = createMockLoop([
      { loopName: 'loop-1', worktreeDir: '/wt-1', workspaceId: 'wrk_1' },
      { loopName: 'loop-2', worktreeDir: '/wt-2', workspaceId: 'wrk_2' },
    ])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loopService as any,
      logger: createMockLogger() as any,
    })

    await expect(lookup(sessionId)).rejects.toBeInstanceOf(ParentLookupUndeterminedError)

    const calls = ((client.session.get as any).mock.calls as unknown[][]).map((c: unknown[]) => c[0] as Record<string, unknown>)
    expect(calls).toHaveLength(5)
    expect(calls[0]).toEqual({ sessionID: sessionId, directory: '/wt-1', workspace: 'wrk_1' })
    expect(calls[1]).toEqual({ sessionID: sessionId, workspace: 'wrk_1' })
    expect(calls[2]).toEqual({ sessionID: sessionId, directory: '/wt-2', workspace: 'wrk_2' })
    expect(calls[3]).toEqual({ sessionID: sessionId, workspace: 'wrk_2' })
    expect(calls[4]).toEqual({ sessionID: sessionId, directory: '/host' })
  })

  it('every unreadable lookup is logged and retried rather than cached as absence', async () => {
    const sessionId = 'ses-3'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => { throw notFoundErr() },
      },
    })

    const loopService = createMockLoop([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])
    const logger = createMockLogger()

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loopService as any,
      logger: logger as any,
    })

    await expect(lookup(sessionId)).rejects.toBeInstanceOf(ParentLookupUndeterminedError)
    await expect(lookup(sessionId)).rejects.toBeInstanceOf(ParentLookupUndeterminedError)
    await expect(lookup(sessionId)).rejects.toBeInstanceOf(ParentLookupUndeterminedError)

    // Caching the failure would freeze a momentary lookup race into a lasting wrong answer, so
    // each call re-attempts every candidate directory (3 attempts per call).
    expect(client.session.get).toHaveBeenCalledTimes(9)
    expect(logger.log).toHaveBeenCalledTimes(3)
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining(`[session-resolver] session.get failed for ${sessionId}`)
    )
  })

  it('positive cache prevents re-fetch', async () => {
    const sessionId = 'ses-4'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => ({ parentID: 'parent-4' }),
      },
    })

    const loopService = createMockLoop([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loopService as any,
      logger: createMockLogger() as any,
    })

    const result1 = await lookup(sessionId)
    expect(result1).toBe('parent-4')

    const result2 = await lookup(sessionId)
    expect(result2).toBe('parent-4')

    expect(client.session.get).toHaveBeenCalledTimes(1)
  })

  it('no active loops fallback to host directory', async () => {
    const sessionId = 'ses-host'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => ({ parentID: 'parent-host' }),
      },
    })

    const loopService = createMockLoop([])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loopService as any,
      logger: createMockLogger() as any,
    })

    const result = await lookup(sessionId)
    expect(result).toBe('parent-host')

    const calls = ((client.session.get as any).mock.calls as unknown[][]).map((c: unknown[]) => c[0] as Record<string, unknown>)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      sessionID: sessionId,
      directory: '/host',
    })
  })

  it('active loop without workspaceId issues directory attempt then host fallback', async () => {
    const sessionId = 'ses-nows'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => { throw notFoundErr() },
      },
    })

    const loopService = createMockLoop([
      { loopName: 'test-loop', worktreeDir: '/wt' },
    ])

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loopService as any,
      logger: createMockLogger() as any,
    })

    await expect(lookup(sessionId)).rejects.toBeInstanceOf(ParentLookupUndeterminedError)

    const calls = ((client.session.get as any).mock.calls as unknown[][]).map((c: unknown[]) => c[0] as Record<string, unknown>)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      sessionID: sessionId,
      directory: '/wt',
    })
    expect(calls[1]).toEqual({
      sessionID: sessionId,
      directory: '/host',
    })
  })

  it('no log noise on zero-attempt empty path', async () => {
    const sessionId = 'ses-no-log'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => { throw notFoundErr() },
      },
    })

    // Active loop with empty worktreeDir (so it's skipped)
    const loopService = createMockLoop([
      { loopName: 'test-loop', worktreeDir: '' },
    ])
    const logger = createMockLogger()

    const lookup = createParentSessionLookup({
      client,
      directory: '/host',
      loop: loopService as any,
      logger: logger as any,
    })

    await expect(lookup(sessionId)).rejects.toBeInstanceOf(ParentLookupUndeterminedError)
    // Only host directory attempt is made because active loop worktreeDir is empty
    expect(client.session.get).toHaveBeenCalledTimes(1)
    expect(client.session.get).toHaveBeenCalledWith({
      sessionID: sessionId,
      directory: '/host',
    })
  })
})

describe('createSessionDirectoryLookup', () => {
  it('with workspaceId, includes workspace and host fallback in attempts', async () => {
    const sessionId = 'ses-5'
    let callCount = 0
    const { client } = createFakeForgeClient({
      session: {
        get: async () => {
          callCount++
          if (callCount <= 2) throw notFoundErr()
          return { directory: '/host' }
        },
      },
    })

    const loopService = createMockLoop([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])

    const lookup = createSessionDirectoryLookup({
      client,
      directory: '/host',
      loop: loopService as any,
    })

    await lookup(sessionId)

    const calls = ((client.session.get as any).mock.calls as unknown[][]).map((c: unknown[]) => c[0] as Record<string, unknown>)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({
      sessionID: sessionId,
      directory: '/wt',
      workspace: 'wrk_x',
    })
    expect(calls[1]).toEqual({
      sessionID: sessionId,
      workspace: 'wrk_x',
    })
    expect(calls[2]).toEqual({
      sessionID: sessionId,
      directory: '/host',
    })
  })

  it('positive result is cached', async () => {
    const sessionId = 'ses-6'
    const { client } = createFakeForgeClient({
      session: {
        get: async () => ({ directory: '/wt' }),
      },
    })

    const loopService = createMockLoop([
      { loopName: 'test-loop', worktreeDir: '/wt', workspaceId: 'wrk_x' },
    ])

    const lookup = createSessionDirectoryLookup({
      client,
      directory: '/host',
      loop: loopService as any,
    })

    const result1 = await lookup(sessionId)
    expect(result1).toBe('/wt')

    const result2 = await lookup(sessionId)
    expect(result2).toBe('/wt')

    expect(client.session.get).toHaveBeenCalledTimes(1)
  })

  it('negative result is cached for the configured TTL', async () => {
    vi.useFakeTimers()
    try {
      const { client } = createFakeForgeClient({
        session: { get: async () => { throw notFoundErr() } },
      })
      const lookup = createSessionDirectoryLookup({
        client,
        directory: '/host',
        loop: createMockLoop([]) as any,
        negativeTtlMs: 100,
      })

      await expect(lookup('ses-missing')).resolves.toBeNull()
      await expect(lookup('ses-missing')).resolves.toBeNull()
      expect(client.session.get).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(101)
      await expect(lookup('ses-missing')).resolves.toBeNull()
      expect(client.session.get).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
