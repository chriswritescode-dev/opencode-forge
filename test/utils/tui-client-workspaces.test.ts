import { describe, it, expect, vi } from 'vitest'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

import { listConnectedWorkspaces } from '../../src/utils/workspace-listing'
import { createForgeClient } from '../../src/client/sdk-adapter'

function createWorkspace(overrides?: {
  syncList?: () => Promise<unknown>
  listOverride?: () => Promise<{ data?: unknown[] }>
  statusOverride?: () => Promise<{ data?: unknown[] }>
  omitList?: boolean
}) {
  const list = overrides?.listOverride ?? vi.fn().mockResolvedValue({
    data: [
      { id: 'ws-1', name: 'loop-a', type: 'worktree', directory: '/wt/a', timeUsed: 100 },
      { id: 'ws-2', name: 'loop-b', type: 'worktree', directory: '/wt/b', timeUsed: 200 },
      { id: 'ws-3', name: 'loop-c', type: 'worktree', directory: '/wt/c', timeUsed: 50 },
    ],
  })
  const status = overrides?.statusOverride ?? vi.fn().mockResolvedValue({
    data: [
      { workspaceID: 'ws-1', status: 'connected' },
      { workspaceID: 'ws-2', status: 'disconnected' },
      { workspaceID: 'ws-3', status: 'connected' },
    ],
  })
  const syncList = overrides?.syncList ?? vi.fn().mockResolvedValue({ data: undefined })
  const workspaceApi: Record<string, unknown> = { status, syncList }
  if (!overrides?.omitList) workspaceApi.list = list
  const client = createForgeClient({ experimental: { workspace: workspaceApi } } as never)
  return { workspace: client.workspace, list, status, syncList }
}

describe('listConnectedWorkspaces', () => {
  it('calls syncList as a sync trigger only and returns entries from list()', async () => {
    const { workspace, list, syncList } = createWorkspace()

    const result = await listConnectedWorkspaces(workspace)

    expect(syncList).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledOnce()
    expect(result).toHaveLength(2)
    const ids = result.map((w) => w.id)
    expect(ids).toContain('ws-1')
    expect(ids).toContain('ws-3')
    expect(ids).not.toContain('ws-2')
  })

  it('calls list() after syncList even when syncList resolves with no data', async () => {
    const { workspace, list, syncList } = createWorkspace()

    const result = await listConnectedWorkspaces(workspace)

    expect(syncList).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledOnce()
    expect(result).toHaveLength(2)
  })

  it('filters to connected (or unknown) workspaces', async () => {
    const { workspace } = createWorkspace()

    const result = await listConnectedWorkspaces(workspace)

    expect(result).toHaveLength(2)
    expect(result.map((w) => w.id)).toEqual(['ws-1', 'ws-3'])
  })

  it('sorts by timeUsed desc', async () => {
    const { workspace } = createWorkspace()

    const result = await listConnectedWorkspaces(workspace)

    expect(result[0].id).toBe('ws-1')
    expect(result[1].id).toBe('ws-3')
  })

  it('returns entries when syncList fails but list() still works', async () => {
    const syncList = vi.fn().mockRejectedValue(new Error('host unavailable'))
    const { workspace, list } = createWorkspace({ syncList })

    const result = await listConnectedWorkspaces(workspace)

    expect(syncList).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledOnce()
    expect(result).toHaveLength(2)
    expect(result.map((w) => w.id)).toContain('ws-1')
  })

  it('returns empty array when experimental.workspace.list is unavailable', async () => {
    const { workspace } = createWorkspace({ omitList: true })
    const result = await listConnectedWorkspaces(workspace)
    expect(result).toEqual([])
  })

  it('returns empty array when list() rejects', async () => {
    const { workspace } = createWorkspace({
      listOverride: vi.fn().mockRejectedValue(new Error('list failed')),
    })
    const result = await listConnectedWorkspaces(workspace)
    expect(result).toEqual([])
  })

  it('includes entries with unknown status', async () => {
    const { workspace } = createWorkspace({
      statusOverride: vi.fn().mockResolvedValue({
        data: [
          { workspaceID: 'ws-1', status: 'connected' },
        ],
      }),
    })

    const result = await listConnectedWorkspaces(workspace)

    expect(result).toHaveLength(3)
    expect(result.map((w) => w.id)).toEqual(['ws-2', 'ws-1', 'ws-3'])
  })

  it('sorts entries from list() by timeUsed desc, not syncList result', async () => {
    const { workspace } = createWorkspace()

    const result = await listConnectedWorkspaces(workspace)

    expect(result[0].id).toBe('ws-1')
    expect(result[1].id).toBe('ws-3')
    expect(result[0].timeUsed).toBeGreaterThan(result[1].timeUsed!)
  })
})
