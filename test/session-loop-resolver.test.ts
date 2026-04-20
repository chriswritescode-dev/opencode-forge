import { describe, it, expect } from 'bun:test'
import { createSessionLoopResolver } from '../src/services/session-loop-resolver'

describe('createSessionLoopResolver', () => {
  const mockLogger = {
    log: () => {},
    debug: () => {},
    error: () => {},
  }

  describe('direct resolution happy path', () => {
    it('returns active loop without consulting parent', async () => {
      const getParentSessionId = async () => { throw new Error('should not be called') }

      const loopService = {
        resolveLoopName: (sessionId: string) => (sessionId === 'session-a' ? 'loop-1' : null),
        getActiveState: (name: string) =>
          name === 'loop-1' ? { loopName: 'loop-1', active: true, sandbox: true } : null,
      }

      const resolver = createSessionLoopResolver({
        loopService,
        getParentSessionId,
        logger: mockLogger,
      })

      const result = await resolver.resolveActiveLoopForSession('session-a')
      expect(result).toEqual({ loopName: 'loop-1', active: true, sandbox: true })
    })
  })

  describe('direct not active → parent hop', () => {
    it('falls back to parent session when direct loop is not active', async () => {
      let parentLookupCalled = false
      const getParentSessionId = async (sessionId: string) => {
        if (sessionId === 'session-a') {
          parentLookupCalled = true
          return 'parent-session-1'
        }
        return null
      }

      const loopService = {
        resolveLoopName: (sessionId: string) => {
          if (sessionId === 'session-a') return 'loop-1'
          if (sessionId === 'parent-session-1') return 'loop-2'
          return null
        },
        getActiveState: (name: string) => {
          if (name === 'loop-1') return { loopName: 'loop-1', active: false, sandbox: true }
          if (name === 'loop-2') return { loopName: 'loop-2', active: true, sandbox: true }
          return null
        },
      }

      const resolver = createSessionLoopResolver({
        loopService,
        getParentSessionId,
        logger: mockLogger,
      })

      const result = await resolver.resolveActiveLoopForSession('session-a')
      expect(parentLookupCalled).toBe(true)
      expect(result).toEqual({ loopName: 'loop-2', active: true, sandbox: true })
    })
  })

  describe('direct not active, no parent', () => {
    it('returns null when direct loop is not active and has no parent', async () => {
      const getParentSessionId = async () => null

      const loopService = {
        resolveLoopName: (sessionId: string) => (sessionId === 'session-a' ? 'loop-1' : null),
        getActiveState: (name: string) =>
          name === 'loop-1' ? { loopName: 'loop-1', active: false, sandbox: true } : null,
      }

      const resolver = createSessionLoopResolver({
        loopService,
        getParentSessionId,
        logger: mockLogger,
      })

      const result = await resolver.resolveActiveLoopForSession('session-a')
      expect(result).toBeNull()
    })
  })

  describe('direct not active, parent lookup does not cache failures', () => {
    it('re-calls getParentSessionId on subsequent invocations for the same session', async () => {
      let callCount = 0
      const getParentSessionId = async (_sessionId: string) => {
        callCount++
        return null
      }

      const loopService = {
        resolveLoopName: () => 'loop-1',
        getActiveState: () => ({ loopName: 'loop-1', active: false, sandbox: true }),
      }

      const resolver = createSessionLoopResolver({
        loopService,
        getParentSessionId,
        logger: mockLogger,
      })

      await resolver.resolveActiveLoopForSession('session-a')
      await resolver.resolveActiveLoopForSession('session-a')
      await resolver.resolveActiveLoopForSession('session-a')

      expect(callCount).toBe(3)
    })
  })

  describe('inactive direct loop still consults parent', () => {
    it('falls back to parent even when direct loop exists but is inactive', async () => {
      let parentLookupCalled = false
      const getParentSessionId = async (sessionId: string) => {
        if (sessionId === 'session-a') {
          parentLookupCalled = true
          return 'parent-session-1'
        }
        return null
      }

      const loopService = {
        resolveLoopName: (sessionId: string) => {
          if (sessionId === 'session-a') return 'loop-1'
          if (sessionId === 'parent-session-1') return 'loop-2'
          return null
        },
        getActiveState: (name: string) => {
          if (name === 'loop-1') return { loopName: 'loop-1', active: false, sandbox: true }
          if (name === 'loop-2') return { loopName: 'loop-2', active: true, sandbox: true }
          return null
        },
      }

      const resolver = createSessionLoopResolver({
        loopService,
        getParentSessionId,
        logger: mockLogger,
      })

      const result = await resolver.resolveActiveLoopForSession('session-a')
      expect(parentLookupCalled).toBe(true)
      expect(result).toEqual({ loopName: 'loop-2', active: true, sandbox: true })
    })
  })

  describe('parent resolves to inactive loop', () => {
    it('returns null when parent resolves to inactive loop', async () => {
      const getParentSessionId = async (sessionId: string) => {
        if (sessionId === 'session-a') return 'parent-session-1'
        return null
      }

      const loopService = {
        resolveLoopName: (sessionId: string) => {
          if (sessionId === 'session-a') return 'loop-1'
          if (sessionId === 'parent-session-1') return 'loop-2'
          return null
        },
        getActiveState: (name: string) => {
          if (name === 'loop-1') return { loopName: 'loop-1', active: false, sandbox: true }
          if (name === 'loop-2') return { loopName: 'loop-2', active: false, sandbox: true }
          return null
        },
        listActive: () => [],
      }

      const resolver = createSessionLoopResolver({
        loopService,
        getParentSessionId,
        logger: mockLogger,
      })

      const result = await resolver.resolveActiveLoopForSession('session-a')
      expect(result).toBeNull()
    })
  })

  describe('directory-fallback', () => {
    it('resolves session when directory matches an active loop worktreeDir', async () => {
      const getParentSessionId = async () => null

      const loopService = {
        resolveLoopName: () => null,
        getActiveState: (name: string) =>
          name === 'loop-worktree' ? { loopName: 'loop-worktree', active: true, sandbox: true, worktreeDir: '/worktree' } : null,
        listActive: () => [{ loopName: 'loop-worktree', worktreeDir: '/worktree', sandbox: true, active: true }],
      }

      const getSessionDirectory = async (_sessionId: string) => '/worktree'

      const resolver = createSessionLoopResolver({
        loopService,
        getParentSessionId,
        getSessionDirectory,
        logger: mockLogger,
      })

      const result = await resolver.resolveActiveLoopForSession('session-subagent')
      expect(result).toEqual({ loopName: 'loop-worktree', active: true, sandbox: true, worktreeDir: '/worktree' })
    })

    it('directory-fallback: directory does not match any active loop returns null', async () => {
      const getParentSessionId = async () => null

      const loopService = {
        resolveLoopName: () => null,
        getActiveState: (name: string) =>
          name === 'loop-worktree' ? { loopName: 'loop-worktree', active: true, sandbox: true, worktreeDir: '/worktree' } : null,
        listActive: () => [{ loopName: 'loop-worktree', worktreeDir: '/worktree', sandbox: true, active: true }],
      }

      const getSessionDirectory = async (_sessionId: string) => '/some-other-dir'

      const resolver = createSessionLoopResolver({
        loopService,
        getParentSessionId,
        getSessionDirectory,
        logger: mockLogger,
      })

      const result = await resolver.resolveActiveLoopForSession('session-unknown')
      expect(result).toBeNull()
    })

    it('getSessionDirectory undefined behaves exactly like today', async () => {
      const getParentSessionId = async () => null

      const loopService = {
        resolveLoopName: (sessionId: string) => (sessionId === 'session-a' ? 'loop-1' : null),
        getActiveState: (name: string) =>
          name === 'loop-1' ? { loopName: 'loop-1', active: false, sandbox: true } : null,
        listActive: () => [{ loopName: 'loop-1', worktreeDir: '/worktree', sandbox: true, active: false }],
      }

      const resolver = createSessionLoopResolver({
        loopService,
        getParentSessionId,
        logger: mockLogger,
      })

      const result = await resolver.resolveActiveLoopForSession('session-a')
      expect(result).toBeNull()
    })

    it('resolves via directory with path normalization', async () => {
      const getParentSessionId = async () => null

      const loopService = {
        resolveLoopName: () => null,
        getActiveState: (name: string) =>
          name === 'loop-worktree' ? { loopName: 'loop-worktree', active: true, sandbox: true, worktreeDir: '/worktree' } : null,
        listActive: () => [{ loopName: 'loop-worktree', worktreeDir: '/worktree/', sandbox: true, active: true }],
      }

      const getSessionDirectory = async (_sessionId: string) => '/worktree'

      const resolver = createSessionLoopResolver({
        loopService,
        getParentSessionId,
        getSessionDirectory,
        logger: mockLogger,
      })

      const result = await resolver.resolveActiveLoopForSession('session-subagent')
      expect(result).toEqual({ loopName: 'loop-worktree', active: true, sandbox: true, worktreeDir: '/worktree' })
    })
  })
})