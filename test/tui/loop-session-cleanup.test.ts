import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Plugin } from '@opencode/plugin/tui'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { removeOrphanedLoopSessions } from '../../src/tui/loop-session-cleanup'
import { forgeWorktreesRoot } from '../../src/workspace/forge-naming'

type ListedSession = { id: string; location: { directory: string } }

function contextWithPages(pages: ListedSession[][]) {
  const list = vi.fn(async () => {
    const data = pages[list.mock.calls.length - 1] ?? []
    return { data, cursor: { next: data.length > 0 ? `cursor-${list.mock.calls.length}` : undefined } }
  })
  const remove = vi.fn(async (_input: { sessionID: string }) => {})
  const ctx = { client: { session: { list, remove } } } as unknown as Plugin.Context
  return { ctx, list, remove }
}

describe('removeOrphanedLoopSessions', () => {
  let dataDir = ''

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'forge-session-cleanup-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('removes only sessions whose Forge worktree directory no longer exists', async () => {
    const live = join(forgeWorktreesRoot(dataDir), 'live-loop')
    mkdirSync(live, { recursive: true })
    const gone = join(forgeWorktreesRoot(dataDir), 'finished-loop')
    const { ctx, remove } = contextWithPages([[
      { id: 'ses_gone_code', location: { directory: gone } },
      { id: 'ses_live', location: { directory: live } },
      { id: 'ses_host', location: { directory: '/missing/project' } },
      { id: 'ses_gone_audit', location: { directory: gone } },
    ]])

    const removed = await removeOrphanedLoopSessions(ctx, 'proj-1', dataDir, new AbortController().signal)

    expect(removed).toBe(2)
    expect(remove.mock.calls.map(([input]) => input.sessionID)).toEqual(['ses_gone_code', 'ses_gone_audit'])
  })

  test('follows the list cursor across full pages', async () => {
    mkdirSync(forgeWorktreesRoot(dataDir), { recursive: true })
    const gone = join(forgeWorktreesRoot(dataDir), 'finished-loop')
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: `ses_${index}`, location: { directory: gone } }))
    const { ctx, list, remove } = contextWithPages([fullPage, [{ id: 'ses_last', location: { directory: gone } }]])

    await removeOrphanedLoopSessions(ctx, 'proj-1', dataDir, new AbortController().signal)

    expect(list.mock.calls).toEqual([[{ project: 'proj-1', limit: 100 }], [{ cursor: 'cursor-1' }]])
    expect(remove).toHaveBeenCalledTimes(101)
  })

  test('does nothing when the Forge worktree root is not on this machine', async () => {
    const { ctx, list, remove } = contextWithPages([[
      { id: 'ses_gone', location: { directory: join(forgeWorktreesRoot(dataDir), 'finished-loop') } },
    ]])

    expect(await removeOrphanedLoopSessions(ctx, 'proj-1', dataDir, new AbortController().signal)).toBe(0)
    expect(list).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})
