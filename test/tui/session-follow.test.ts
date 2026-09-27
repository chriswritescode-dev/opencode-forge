import { describe, test, expect, vi } from 'vitest'
import type { Plugin } from '@opencode/plugin/tui'
import { attachV2LoopSessionFollower, shouldFollowNewSession } from '../../src/tui/session-follow'

type FollowerRoute = { type: 'home' } | { type: 'session'; sessionID: string }

function createFollowerContext(options: {
  route: FollowerRoute
  sessions?: Array<{ id: string; location: { directory: string } }>
}) {
  let route = options.route
  const handlers = new Map<string, Array<(event: { data: Record<string, unknown> }) => void>>()
  const navigations: FollowerRoute[] = []
  const ctx = {
    data: {
      on: (type: string, handler: (event: { data: Record<string, unknown> }) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), handler])
        return () => {}
      },
      session: {
        get: (id: string) => options.sessions?.find((session) => session.id === id),
      },
    },
    ui: {
      router: {
        current: () => route,
        navigate: (destination: FollowerRoute) => {
          navigations.push(destination)
          route = destination
        },
      },
    },
  } as unknown as Plugin.Context
  const emit = (data: Record<string, unknown>) => {
    for (const handler of handlers.get('session.created') ?? []) handler({ data })
  }
  const setRoute = (next: FollowerRoute) => { route = next }
  return { ctx, emit, navigations, setRoute }
}

describe('shouldFollowNewSession', () => {
  test('follows when current and new session share a workspace', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', scope: 'ws-forge-1' },
      currentSession: { id: 'old', scope: 'ws-forge-1' },
    })
    expect(decision).toBe(true)
  })

  test('skips when not on any session', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', scope: 'ws-forge-1' },
      currentSession: null,
    })
    expect(decision).toBe(false)
  })

  test('skips when user is already on the new session', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'same', scope: 'ws-forge-1' },
      currentSession: { id: 'same', scope: 'ws-forge-1' },
    })
    expect(decision).toBe(false)
  })

  test('skips when the new session has no workspace', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', scope: undefined },
      currentSession: { id: 'old', scope: 'ws-forge-1' },
    })
    expect(decision).toBe(false)
  })

  test('skips when the current session is in a different workspace', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', scope: 'ws-forge-1' },
      currentSession: { id: 'old', scope: 'ws-forge-2' },
    })
    expect(decision).toBe(false)
  })

  test('skips when the current session has no workspace (host session)', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', scope: 'ws-forge-1' },
      currentSession: { id: 'host', scope: undefined },
    })
    expect(decision).toBe(false)
  })

  test('skips when the new session is a subagent/child (has parentID)', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'subagent', scope: 'ws-forge-1', parentID: 'old' },
      currentSession: { id: 'old', scope: 'ws-forge-1' },
    })
    expect(decision).toBe(false)
  })
})

describe('attachV2LoopSessionFollower', () => {
  test('navigates to a new loop session in the viewed worktree after awaiting the predicate', async () => {
    const fake = createFollowerContext({
      route: { type: 'session', sessionID: 'ses_code' },
      sessions: [{ id: 'ses_code', location: { directory: '/loop' } }],
    })
    const detach = attachV2LoopSessionFollower(fake.ctx, async (directory) => directory === '/loop')

    fake.emit({ sessionID: 'ses_audit', location: { directory: '/loop' } })

    expect(fake.navigations).toEqual([])
    await vi.waitFor(() => expect(fake.navigations).toEqual([{ type: 'session', sessionID: 'ses_audit' }]))
    detach()
  })

  test('does not navigate when the predicate reports a non-loop directory', async () => {
    const fake = createFollowerContext({
      route: { type: 'session', sessionID: 'ses_code' },
      sessions: [{ id: 'ses_code', location: { directory: '/loop' } }],
    })
    const detach = attachV2LoopSessionFollower(fake.ctx, async () => false)

    fake.emit({ sessionID: 'ses_other', location: { directory: '/loop' } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fake.navigations).toEqual([])
    detach()
  })

  test('does not navigate when the route changes while the async predicate is in flight', async () => {
    const fake = createFollowerContext({
      route: { type: 'session', sessionID: 'ses_code' },
      sessions: [{ id: 'ses_code', location: { directory: '/loop' } }],
    })
    let resolvePredicate!: (value: boolean) => void
    const predicate = vi.fn(() => new Promise<boolean>((resolve) => { resolvePredicate = resolve }))
    const detach = attachV2LoopSessionFollower(fake.ctx, predicate)

    fake.emit({ sessionID: 'ses_audit', location: { directory: '/loop' } })
    fake.setRoute({ type: 'home' })
    resolvePredicate(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fake.navigations).toEqual([])
    detach()
  })

  test('does not navigate when the user moved to a different session during the await', async () => {
    const fake = createFollowerContext({
      route: { type: 'session', sessionID: 'ses_code' },
      sessions: [
        { id: 'ses_code', location: { directory: '/loop' } },
        { id: 'ses_elsewhere', location: { directory: '/other' } },
      ],
    })
    let resolvePredicate!: (value: boolean) => void
    const predicate = vi.fn(() => new Promise<boolean>((resolve) => { resolvePredicate = resolve }))
    const detach = attachV2LoopSessionFollower(fake.ctx, predicate)

    fake.emit({ sessionID: 'ses_audit', location: { directory: '/loop' } })
    fake.setRoute({ type: 'session', sessionID: 'ses_elsewhere' })
    resolvePredicate(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fake.navigations).toEqual([])
    detach()
  })
})
