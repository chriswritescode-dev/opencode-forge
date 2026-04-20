import { describe, it, expect } from 'bun:test'
import { createParentSessionLookup } from '../src/index'

type SessionGetInput = { sessionID: string; directory?: string }

describe('createParentSessionLookup', () => {
  function createLogger() {
    const messages: string[] = []
    return {
      logger: {
        log: (message: string) => { messages.push(message) },
        debug: () => {},
        error: () => {},
      },
      messages,
    }
  }

  function createLoopService(worktreeDirs: Array<{ loopName: string; worktreeDir: string }>) {
    return {
      listActive: () => worktreeDirs.map((state) => ({ ...state })),
    }
  }

  it('returns the parent when the no-directory lookup succeeds immediately', async () => {
    const calls: SessionGetInput[] = []
    const { logger } = createLogger()
    const lookup = createParentSessionLookup({
      v2: {
        session: {
          get: async (input: SessionGetInput) => {
            calls.push(input)
            return { data: { parentID: 'p1' } }
          },
        },
      } as never,
      directory: '/host',
      loopService: createLoopService([]) as never,
      logger: logger as never,
    })

    await expect(lookup('session-a')).resolves.toBe('p1')
    expect(calls).toEqual([{ sessionID: 'session-a' }])
  })

  it('falls back from no-directory lookup to the active worktree directory', async () => {
    const calls: SessionGetInput[] = []
    const { logger } = createLogger()
    const lookup = createParentSessionLookup({
      v2: {
        session: {
          get: async (input: SessionGetInput) => {
            calls.push(input)
            if (calls.length === 1) throw new Error('no-dir failed')
            return { data: { parentID: 'p2' } }
          },
        },
      } as never,
      directory: '/host',
      loopService: createLoopService([{ loopName: 'loop-a', worktreeDir: '/wt' }]) as never,
      logger: logger as never,
    })

    await expect(lookup('session-b')).resolves.toBe('p2')
    expect(calls).toEqual([
      { sessionID: 'session-b' },
      { sessionID: 'session-b', directory: '/wt' },
    ])
  })

  it('tries multiple active worktree directories in order until one succeeds', async () => {
    const calls: SessionGetInput[] = []
    const { logger } = createLogger()
    const lookup = createParentSessionLookup({
      v2: {
        session: {
          get: async (input: SessionGetInput) => {
            calls.push(input)
            if (input.directory === '/wt-2') {
              return { data: { parentID: 'p3' } }
            }
            throw new Error(`failed:${input.directory ?? 'none'}`)
          },
        },
      } as never,
      directory: '/host',
      loopService: createLoopService([
        { loopName: 'loop-a', worktreeDir: '/wt-1' },
        { loopName: 'loop-b', worktreeDir: '/wt-2' },
      ]) as never,
      logger: logger as never,
    })

    await expect(lookup('session-c')).resolves.toBe('p3')
    expect(calls).toEqual([
      { sessionID: 'session-c' },
      { sessionID: 'session-c', directory: '/wt-1' },
      { sessionID: 'session-c', directory: '/wt-2' },
    ])
  })

  it('returns null on repeated failure without caching the failed lookup', async () => {
    const calls: SessionGetInput[] = []
    const { logger } = createLogger()
    const lookup = createParentSessionLookup({
      v2: {
        session: {
          get: async (input: SessionGetInput) => {
            calls.push(input)
            throw new Error('boom')
          },
        },
      } as never,
      directory: '/host',
      loopService: createLoopService([{ loopName: 'loop-a', worktreeDir: '/wt' }]) as never,
      logger: logger as never,
    })

    await expect(lookup('session-d')).resolves.toBeNull()
    await expect(lookup('session-d')).resolves.toBeNull()
    expect(calls).toHaveLength(6)
  })

  it('caches successful lookups including null parents returned by the server', async () => {
    const calls: SessionGetInput[] = []
    const { logger } = createLogger()
    const lookup = createParentSessionLookup({
      v2: {
        session: {
          get: async (input: SessionGetInput) => {
            calls.push(input)
            return { data: { parentID: null } }
          },
        },
      } as never,
      directory: '/host',
      loopService: createLoopService([{ loopName: 'loop-a', worktreeDir: '/wt' }]) as never,
      logger: logger as never,
    })

    await expect(lookup('session-e')).resolves.toBeNull()
    await expect(lookup('session-e')).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('logs the session id and attempted directories when every lookup fails', async () => {
    const { logger, messages } = createLogger()
    const lookup = createParentSessionLookup({
      v2: {
        session: {
          get: async () => {
            throw new Error('denied')
          },
        },
      } as never,
      directory: '/host',
      loopService: createLoopService([{ loopName: 'loop-a', worktreeDir: '/wt' }]) as never,
      logger: logger as never,
    })

    await expect(lookup('session-f')).resolves.toBeNull()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('session-f')
    expect(messages[0]).toContain('loop:loop-a[/wt]')
    expect(messages[0]).toContain('host[/host]')
  })
})
