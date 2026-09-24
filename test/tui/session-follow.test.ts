import { describe, test, expect } from 'vitest'
import { shouldFollowNewSession } from '../../src/tui/session-follow'

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
