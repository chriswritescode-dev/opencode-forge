import { describe, test, expect } from 'vitest'
import { shouldFollowNewSession } from '../../src/tui/session-follow'

describe('shouldFollowNewSession', () => {
  test('follows when current and new session share a workspace', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: 'ws-forge-1' },
      currentSession: { id: 'old', workspaceID: 'ws-forge-1' },
    })
    expect(decision).toBe(true)
  })

  test('skips when not on any session', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: 'ws-forge-1' },
      currentSession: null,
    })
    expect(decision).toBe(false)
  })

  test('skips when user is already on the new session', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'same', workspaceID: 'ws-forge-1' },
      currentSession: { id: 'same', workspaceID: 'ws-forge-1' },
    })
    expect(decision).toBe(false)
  })

  test('skips when the new session has no workspace', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: undefined },
      currentSession: { id: 'old', workspaceID: 'ws-forge-1' },
    })
    expect(decision).toBe(false)
  })

  test('skips when the current session is in a different workspace', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: 'ws-forge-1' },
      currentSession: { id: 'old', workspaceID: 'ws-forge-2' },
    })
    expect(decision).toBe(false)
  })

  test('skips when the current session has no workspace (host session)', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: 'ws-forge-1' },
      currentSession: { id: 'host', workspaceID: undefined },
    })
    expect(decision).toBe(false)
  })

  test('skips when the new session is a subagent/child (has parentID)', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'subagent', workspaceID: 'ws-forge-1', parentID: 'old' },
      currentSession: { id: 'old', workspaceID: 'ws-forge-1' },
    })
    expect(decision).toBe(false)
  })
})
