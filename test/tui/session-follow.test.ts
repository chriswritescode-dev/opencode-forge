import { describe, test, expect } from 'vitest'
import { shouldFollowNewSession } from '../../src/tui/session-follow'

const forgeWorkspaces = new Set(['ws-forge-1', 'ws-forge-2'])
const isForgeWorkspace = (id: string): boolean => forgeWorkspaces.has(id)

describe('shouldFollowNewSession', () => {
  test('follows when current and new session share a forge workspace', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: 'ws-forge-1' },
      currentSession: { id: 'old', workspaceID: 'ws-forge-1' },
      isForgeWorkspace,
    })
    expect(decision).toBe(true)
  })

  test('skips when not on any session', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: 'ws-forge-1' },
      currentSession: null,
      isForgeWorkspace,
    })
    expect(decision).toBe(false)
  })

  test('skips when user is already on the new session', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'same', workspaceID: 'ws-forge-1' },
      currentSession: { id: 'same', workspaceID: 'ws-forge-1' },
      isForgeWorkspace,
    })
    expect(decision).toBe(false)
  })

  test('skips when the new session has no workspace', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: undefined },
      currentSession: { id: 'old', workspaceID: 'ws-forge-1' },
      isForgeWorkspace,
    })
    expect(decision).toBe(false)
  })

  test('skips when the current session is in a different workspace', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: 'ws-forge-1' },
      currentSession: { id: 'old', workspaceID: 'ws-forge-2' },
      isForgeWorkspace,
    })
    expect(decision).toBe(false)
  })

  test('skips when the current session has no workspace (host session)', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: 'ws-forge-1' },
      currentSession: { id: 'host', workspaceID: undefined },
      isForgeWorkspace,
    })
    expect(decision).toBe(false)
  })

  test('skips when the shared workspace is not a forge workspace', () => {
    const decision = shouldFollowNewSession({
      newSession: { id: 'new', workspaceID: 'ws-other' },
      currentSession: { id: 'old', workspaceID: 'ws-other' },
      isForgeWorkspace,
    })
    expect(decision).toBe(false)
  })
})
