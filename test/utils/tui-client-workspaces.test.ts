import { describe, it, expect, vi } from 'vitest'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

import { listConnectedWorkspaces } from '../../src/utils/workspace-listing'

function createWorkspaceApi(overrides?: {
  syncList?: () => Promise<unknown>
  listOverride?: () => Promise<{ data: unknown[] }>
  statusOverride?: () => Promise<{ data: unknown[] }>
}) {
  return {
    list: overrides?.listOverride ?? vi.fn().mockResolvedValue({
      data: [
        { id: 'ws-1', name: 'loop-a', type: 'worktree', directory: '/wt/a', timeUsed: 100 },
        { id: 'ws-2', name: 'loop-b', type: 'worktree', directory: '/wt/b', timeUsed: 200 },
        { id: 'ws-3', name: 'loop-c', type: 'worktree', directory: '/wt/c', timeUsed: 50 },
      ],
    }),
    status: overrides?.statusOverride ?? vi.fn().mockResolvedValue({
      data: [
        { workspaceID: 'ws-1', status: 'connected' },
        { workspaceID: 'ws-2', status: 'disconnected' },
        { workspaceID: 'ws-3', status: 'connected' },
      ],
    }),
    ...(overrides?.syncList !== undefined ? { syncList: overrides.syncList } : {}),
  }
}

describe('listConnectedWorkspaces', () => {
  it('calls syncList as a sync trigger only and returns entries from list()', async () => {
    const syncList = vi.fn().mockResolvedValue(undefined)
    const api = createWorkspaceApi({ syncList })

    const result = await listConnectedWorkspaces(api)

    expect(syncList).toHaveBeenCalledOnce()
    expect(api.list).toHaveBeenCalledOnce()
    expect(result).toHaveLength(2)
    const ids = result.map((w) => w.id)
    expect(ids).toContain('ws-1')
    expect(ids).toContain('ws-3')
    expect(ids).not.toContain('ws-2')
  })

  it('calls list() after syncList even when syncList resolves with no data', async () => {
    const syncList = vi.fn().mockResolvedValue({ data: undefined })
    const api = createWorkspaceApi({ syncList })

    const result = await listConnectedWorkspaces(api)

    expect(syncList).toHaveBeenCalledOnce()
    expect(api.list).toHaveBeenCalledOnce()
    expect(result).toHaveLength(2)
  })

  it('falls back to list() when syncList is not available', async () => {
    const api = createWorkspaceApi()

    const result = await listConnectedWorkspaces(api)

    expect(api.list).toHaveBeenCalledOnce()
    expect(result).toHaveLength(2)
  })

  it('filters to connected (or unknown) workspaces', async () => {
    const api = createWorkspaceApi()

    const result = await listConnectedWorkspaces(api)

    expect(result).toHaveLength(2)
    expect(result.map((w) => w.id)).toEqual(['ws-1', 'ws-3'])
  })

  it('sorts by timeUsed desc', async () => {
    const api = createWorkspaceApi()

    const result = await listConnectedWorkspaces(api)

    expect(result[0].id).toBe('ws-1')
    expect(result[1].id).toBe('ws-3')
  })

  it('returns empty array when syncList fails but list() still works', async () => {
    const syncList = vi.fn().mockRejectedValue(new Error('host unavailable'))
    const api = createWorkspaceApi({ syncList })

    const result = await listConnectedWorkspaces(api)

    expect(syncList).toHaveBeenCalledOnce()
    expect(api.list).toHaveBeenCalledOnce()
    expect(result).toHaveLength(2)
    expect(result.map((w) => w.id)).toContain('ws-1')
  })

  it('returns empty array when workspaceApi is undefined', async () => {
    const result = await listConnectedWorkspaces(undefined)
    expect(result).toEqual([])
  })

  it('returns empty array when list is not a function', async () => {
    const api = { status: vi.fn(), syncList: vi.fn() }
    const result = await listConnectedWorkspaces(api)
    expect(result).toEqual([])
  })

  it('includes entries with unknown status', async () => {
    const api = createWorkspaceApi({
      statusOverride: vi.fn().mockResolvedValue({
        data: [
          { workspaceID: 'ws-1', status: 'connected' },
        ],
      }),
    })

    const result = await listConnectedWorkspaces(api)

    expect(result).toHaveLength(3)
    expect(result.map((w) => w.id)).toEqual(['ws-2', 'ws-1', 'ws-3'])
  })

  it('sorts entries from list() by timeUsed desc, not syncList result', async () => {
    const syncList = vi.fn().mockResolvedValue({ data: [{ id: 'ws-sync' }] })
    const api = createWorkspaceApi({ syncList })

    const result = await listConnectedWorkspaces(api)

    expect(result[0].id).toBe('ws-1')
    expect(result[1].id).toBe('ws-3')
    expect(result[0].timeUsed).toBeGreaterThan(result[1].timeUsed!)
  })
})
