import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Plugin } from '@opencode/plugin/tui'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { removeOrphanedLoopSessions, type LoadForgeWorktrees } from '../../src/tui/loop-session-cleanup'
import type { ForgeWorktreesOutput } from '../../src/host/forge-rpc'
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

function worktreesLoader(...snapshots: ForgeWorktreesOutput[]) {
  let index = 0
  return vi.fn<LoadForgeWorktrees>(async () => snapshots[Math.min(index++, snapshots.length - 1)]!)
}

describe('removeOrphanedLoopSessions', () => {
  let dataDir = ''
  let root = ''

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'forge-session-cleanup-'))
    root = forgeWorktreesRoot(dataDir)
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('removes only sessions whose worktree dir is absent from the server list', async () => {
    const live = join(root, 'live-loop')
    const gone = join(root, 'finished-loop')
    const { ctx, remove } = contextWithPages([[
      { id: 'ses_gone_code', location: { directory: gone } },
      { id: 'ses_live', location: { directory: live } },
      { id: 'ses_host', location: { directory: '/missing/project' } },
      { id: 'ses_gone_audit', location: { directory: gone } },
    ]])

    const removed = await removeOrphanedLoopSessions(ctx, 'proj-1', worktreesLoader({ root, dirs: [live] }), new AbortController().signal)

    expect(removed).toBe(2)
    expect(remove.mock.calls.map(([input]) => input.sessionID)).toEqual(['ses_gone_code', 'ses_gone_audit'])
  })

  test('matches a session nested below a worktree dir to that worktree', async () => {
    const live = join(root, 'live-loop')
    const { ctx, remove } = contextWithPages([[
      { id: 'ses_nested_live', location: { directory: join(live, 'src') } },
      { id: 'ses_nested_gone', location: { directory: join(root, 'finished-loop', 'src') } },
    ]])

    const removed = await removeOrphanedLoopSessions(ctx, 'proj-1', worktreesLoader({ root, dirs: [live] }), new AbortController().signal)

    expect(removed).toBe(1)
    expect(remove.mock.calls.map(([input]) => input.sessionID)).toEqual(['ses_nested_gone'])
  })

  test('never removes a session whose directory is the worktrees root itself', async () => {
    const { ctx, remove } = contextWithPages([[{ id: 'ses_root', location: { directory: root } }]])

    const removed = await removeOrphanedLoopSessions(ctx, 'proj-1', worktreesLoader({ root, dirs: [] }), new AbortController().signal)

    expect(removed).toBe(0)
    expect(remove).not.toHaveBeenCalled()
  })

  test('ignores sessions outside the worktrees root', async () => {
    const { ctx, remove } = contextWithPages([[
      { id: 'ses_host', location: { directory: '/missing/project' } },
      { id: 'ses_sibling', location: { directory: `${root}-archive/x` } },
    ]])

    const removed = await removeOrphanedLoopSessions(ctx, 'proj-1', worktreesLoader({ root, dirs: [] }), new AbortController().signal)

    expect(removed).toBe(0)
    expect(remove).not.toHaveBeenCalled()
  })

  test('follows the list cursor across full pages', async () => {
    const gone = join(root, 'finished-loop')
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: `ses_${index}`, location: { directory: gone } }))
    const { ctx, list, remove } = contextWithPages([fullPage, [{ id: 'ses_last', location: { directory: gone } }]])

    await removeOrphanedLoopSessions(ctx, 'proj-1', worktreesLoader({ root, dirs: [] }), new AbortController().signal)

    expect(list.mock.calls).toEqual([[{ project: 'proj-1', limit: 100 }], [{ cursor: 'cursor-1' }]])
    expect(remove).toHaveBeenCalledTimes(101)
  })

  test('keeps a session whose worktree appears between the first and second worktree fetch', async () => {
    const live = join(root, 'live-loop')
    const spawned = join(root, 'spawned-loop')
    const gone = join(root, 'finished-loop')
    const { ctx, remove } = contextWithPages([[
      { id: 'ses_spawned', location: { directory: spawned } },
      { id: 'ses_gone', location: { directory: gone } },
    ]])
    const loadWorktrees = worktreesLoader({ root, dirs: [live] }, { root, dirs: [live, spawned] })

    const removed = await removeOrphanedLoopSessions(ctx, 'proj-1', loadWorktrees, new AbortController().signal)

    expect(loadWorktrees).toHaveBeenCalledTimes(2)
    expect(removed).toBe(1)
    expect(remove.mock.calls.map(([input]) => input.sessionID)).toEqual(['ses_gone'])
  })

  test('deletes nothing when the second worktree fetch fails', async () => {
    const gone = join(root, 'finished-loop')
    const { ctx, remove } = contextWithPages([[{ id: 'ses_gone', location: { directory: gone } }]])

    const removed = await removeOrphanedLoopSessions(
      ctx,
      'proj-1',
      worktreesLoader({ root, dirs: [] }, { error: 'rpc down' }),
      new AbortController().signal,
    )

    expect(removed).toBe(0)
    expect(remove).not.toHaveBeenCalled()
  })

  test('deletes nothing when the first worktree fetch fails', async () => {
    const gone = join(root, 'finished-loop')
    const { ctx, list, remove } = contextWithPages([[{ id: 'ses_gone', location: { directory: gone } }]])

    const removed = await removeOrphanedLoopSessions(ctx, 'proj-1', worktreesLoader({ error: 'rpc down' }), new AbortController().signal)

    expect(removed).toBe(0)
    expect(list).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})
