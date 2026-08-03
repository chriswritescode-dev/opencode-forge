import { describe, test, expect } from 'vitest'
import { createUnifiedSandboxResolver, type UnifiedSandboxResolverDeps } from '../src/services/unified-sandbox-resolver'
import type { SandboxContext } from '../src/sandbox/context'

function makeHostContainer(name: string): SandboxContext {
  return { runtime: {} as SandboxContext['runtime'], containerName: name, hostDir: '/work', mounts: [] }
}

function makeDeps(overrides: Partial<UnifiedSandboxResolverDeps> = {}): UnifiedSandboxResolverDeps {
  return {
    resolveActiveLoopForSession: async () => null,
    resolveLoopSandbox: async (resolved) => (resolved.sandbox ? makeHostContainer(`loop-${resolved.loopName}`) : null),
    resolveHostSandbox: async () => makeHostContainer('host-container'),
    ...overrides,
  }
}

describe('createUnifiedSandboxResolver', () => {
  test('an active sandbox loop takes precedence and the host sandbox is never consulted', async () => {
    let hostCalled = 0
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => ({ loopName: 'loop-x', active: true, sandbox: true }),
        resolveHostSandbox: async () => {
          hostCalled++
          return makeHostContainer('host-container')
        },
      }),
    )
    const ctx = await resolver('ses-1')
    expect(ctx?.containerName).toBe('loop-loop-x')
    expect(hostCalled).toBe(0)
  })

  test('an active non-sandbox loop forces host (returns null) and never consults the host sandbox', async () => {
    let hostCalled = 0
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => ({ loopName: 'loop-wt', active: true, worktree: true }),
        resolveHostSandbox: async () => {
          hostCalled++
          return makeHostContainer('host-container')
        },
      }),
    )
    const ctx = await resolver('ses-1')
    expect(ctx).toBeNull()
    expect(hostCalled).toBe(0)
  })

  test('a sandbox loop that starts during deferred host resolution wins over the host sandbox', async () => {
    let hostCalled = 0
    let loopStarted = false
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => {
          // No loop on the first (pre-host) check; a sandbox loop exists once the host restore runs.
          if (hostCalled === 0) return null
          return loopStarted ? { loopName: 'loop-new', active: true, sandbox: true } : null
        },
        resolveHostSandbox: async () => {
          hostCalled++
          // The asynchronous host restore completes after a sandbox loop has started.
          loopStarted = true
          return makeHostContainer('host-container')
        },
      }),
    )
    const ctx = await resolver('ses-1')
    // Loop-first precedence wins: the newly active loop's sandbox is returned, not the host sandbox.
    expect(ctx?.containerName).toBe('loop-loop-new')
  })

  test('a non-sandbox loop that starts during deferred host resolution forces host (returns null)', async () => {
    let hostCalled = 0
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => (hostCalled === 0 ? null : { loopName: 'loop-wt', active: true, worktree: true }),
        resolveHostSandbox: async () => {
          hostCalled++
          return makeHostContainer('host-container')
        },
      }),
    )
    const ctx = await resolver('ses-1')
    expect(ctx).toBeNull()
  })

  test('a sandbox loop that starts while the host sandbox rejects wins over the stale host error', async () => {
    let hostCalled = 0
    let loopStarted = false
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => {
          if (hostCalled === 0) return null
          return loopStarted ? { loopName: 'loop-new', active: true, sandbox: true } : null
        },
        resolveHostSandbox: async () => {
          hostCalled++
          loopStarted = true
          throw new Error('host restore failed')
        },
      }),
    )
    // Loop-first precedence wins even when the host path rejected: the stale host error must not
    // override the newly active sandbox loop.
    const ctx = await resolver('ses-1', { throwOnRestoreError: true })
    expect(ctx?.containerName).toBe('loop-loop-new')
  })

  test('a non-sandbox loop that starts while the host sandbox rejects forces host (returns null)', async () => {
    let hostCalled = 0
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => (hostCalled === 0 ? null : { loopName: 'loop-wt', active: true, worktree: true }),
        resolveHostSandbox: async () => {
          hostCalled++
          throw new Error('host restore failed')
        },
      }),
    )
    const ctx = await resolver('ses-1', { throwOnRestoreError: true })
    expect(ctx).toBeNull()
  })

  test('a host resolution rejection with no concurrent loop propagates the host error', async () => {
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveHostSandbox: async () => {
          throw new Error('host restore failed')
        },
      }),
    )
    await expect(resolver('ses-1', { throwOnRestoreError: true })).rejects.toThrow(/host restore failed/)
  })

  test('no loop anywhere returns the host sandbox context', async () => {
    const resolver = createUnifiedSandboxResolver(makeDeps())
    const ctx = await resolver('ses-1')
    expect(ctx?.containerName).toBe('host-container')
  })

  test('an unavailable loop sandbox fails closed when throwOnRestoreError is set', async () => {
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => ({ loopName: 'loop-x', active: true, sandbox: true }),
        resolveLoopSandbox: async () => null,
      }),
    )
    await expect(resolver('ses-1', { throwOnRestoreError: true })).rejects.toThrow(/loop "loop-x" is unavailable/)
    await expect(resolver('ses-1')).resolves.toBeNull()
  })

  test('revalidates after restoration and follows a loop replaced by another sandbox loop', async () => {
    let call = 0
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => {
          call++
          if (call === 1) return { loopName: 'loop-a', active: true, sandbox: true }
          return { loopName: 'loop-b', active: true, sandbox: true }
        },
      }),
    )
    // The loop captured before restoration was A; after restoration the session belongs to B, so the
    // resolver must follow B rather than returning A's stale container.
    const ctx = await resolver('ses-1')
    expect(ctx?.containerName).toBe('loop-loop-b')
  })

  test('revalidates after restoration and returns null when the loop becomes non-sandbox', async () => {
    let call = 0
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => {
          call++
          if (call === 1) return { loopName: 'loop-a', active: true, sandbox: true }
          return { loopName: 'loop-wt', active: true, worktree: true }
        },
      }),
    )
    // The session was in a sandbox loop when resolution started but that loop became a non-sandbox
    // loop during restoration: the stale sandbox container must not be returned.
    const ctx = await resolver('ses-1')
    expect(ctx).toBeNull()
  })

  test('revalidates after restoration and falls back to the host when the loop terminates', async () => {
    let call = 0
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => {
          call++
          if (call === 1) return { loopName: 'loop-a', active: true, sandbox: true }
          return null
        },
      }),
    )
    // The sandbox loop terminated during restoration; with no active loop remaining the host-session
    // path applies rather than returning (or recreating) the terminated loop's container.
    const ctx = await resolver('ses-1')
    expect(ctx?.containerName).toBe('host-container')
  })

  test('revalidates after restoration when the restore rejects and the loop changed', async () => {
    let call = 0
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => {
          call++
          if (call === 1) return { loopName: 'loop-a', active: true, sandbox: true }
          return { loopName: 'loop-b', active: true, sandbox: true }
        },
        resolveLoopSandbox: async (resolved) => {
          if (resolved.loopName === 'loop-a') throw new Error('loop-a restore failed')
          return makeHostContainer('loop-loop-b')
        },
      }),
    )
    // loop-a's restoration rejects, but by the time it rejects the session belongs to loop-b: the
    // stale loop-a error must not determine routing; the resolver follows the current loop-b.
    const ctx = await resolver('ses-1', { throwOnRestoreError: true })
    expect(ctx?.containerName).toBe('loop-loop-b')
  })

  test('revalidates after restoration when the restore returns null and the loop changed', async () => {
    let call = 0
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => {
          call++
          if (call === 1) return { loopName: 'loop-a', active: true, sandbox: true }
          return { loopName: 'loop-b', active: true, sandbox: true }
        },
        resolveLoopSandbox: async (resolved) =>
          resolved.loopName === 'loop-a' ? null : makeHostContainer('loop-loop-b'),
      }),
    )
    // loop-a's restoration returned no sandbox, but the session now belongs to loop-b: routing must
    // follow the current loop-b rather than returning a stale null for the replaced loop.
    const ctx = await resolver('ses-1')
    expect(ctx?.containerName).toBe('loop-loop-b')
  })

  test('fails closed when a loop keeps changing past the revalidation retry cap', async () => {
    let call = 0
    const resolver = createUnifiedSandboxResolver(
      makeDeps({
        resolveActiveLoopForSession: async () => {
          call++
          return { loopName: `loop-${call}`, active: true, sandbox: true }
        },
        resolveLoopSandbox: async (resolved) => makeHostContainer(`loop-${resolved.loopName}`),
      }),
    )
    // Every revalidation reports a NEW loop name, so the resolver never settles on a stable loop and
    // exhausts its retry budget. It must fail closed (throw) rather than return a stale loop context.
    await expect(resolver('ses-1')).rejects.toThrow(/unavailable/)
  })
})
