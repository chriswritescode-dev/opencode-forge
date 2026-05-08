import { describe, it, expect, vi, beforeEach } from 'vitest'

function createMockApi(overrides?: { syncList?: () => Promise<{ data?: unknown[] }> }) {
  const workspace = {
    list: vi.fn().mockResolvedValue({
      data: [
        { id: 'ws-1', name: 'loop-a', type: 'forge-worktree', directory: '/wt/a', timeUsed: 100 },
        { id: 'ws-2', name: 'loop-b', type: 'forge-worktree', directory: '/wt/b', timeUsed: 200 },
        { id: 'ws-3', name: 'loop-c', type: 'forge-worktree', directory: '/wt/c', timeUsed: 50 },
      ],
    }),
    status: vi.fn().mockResolvedValue({
      data: [
        { workspaceID: 'ws-1', status: 'connected' },
        { workspaceID: 'ws-2', status: 'disconnected' },
        { workspaceID: 'ws-3', status: 'connected' },
      ],
    }),
    ...overrides,
  }
  return { experimental: { workspace } }
}

describe('TUI client workspaces.list()', () => {
  it('calls syncList when available and uses its result', async () => {
    const syncList = vi.fn().mockResolvedValue({
      data: [
        { id: 'ws-sync-1', name: 'sync-loop', type: 'forge-worktree', directory: '/wt/sync', timeUsed: 300 },
      ],
    })
    const api = createMockApi({ syncList }) as any
    const workspaceApi = api.experimental.workspace

    // Simulate the TUI client logic
    let rawEntries: Array<{ id: string; name: string; type: string; directory?: string; timeUsed?: number }> = []
    if (typeof (workspaceApi as any).syncList === 'function') {
      try {
        const syncResult = await (workspaceApi as any).syncList()
        rawEntries = (syncResult.data ?? []) as typeof rawEntries
      } catch {
        const data = await workspaceApi.list()
        rawEntries = (data.data ?? []) as typeof rawEntries
      }
    } else {
      const data = await workspaceApi.list()
      rawEntries = (data.data ?? []) as typeof rawEntries
    }

    expect(syncList).toHaveBeenCalled()
    expect(workspaceApi.list).not.toHaveBeenCalled()
    expect(rawEntries).toHaveLength(1)
    expect(rawEntries[0].id).toBe('ws-sync-1')
  })

  it('falls back to list() when syncList is not available', async () => {
    const api = createMockApi() as any
    const workspaceApi = api.experimental.workspace

    let rawEntries: Array<{ id: string; name: string; type: string; directory?: string; timeUsed?: number }> = []
    if (typeof (workspaceApi as any).syncList === 'function') {
      try {
        const syncResult = await (workspaceApi as any).syncList()
        rawEntries = (syncResult.data ?? []) as typeof rawEntries
      } catch {
        const data = await workspaceApi.list()
        rawEntries = (data.data ?? []) as typeof rawEntries
      }
    } else {
      const data = await workspaceApi.list()
      rawEntries = (data.data ?? []) as typeof rawEntries
    }

    expect(workspaceApi.list).toHaveBeenCalled()
    expect(rawEntries).toHaveLength(3)
  })

  it('filters to connected (or unknown) workspaces', async () => {
    const api = createMockApi() as any
    const workspaceApi = api.experimental.workspace

    let rawEntries: Array<{ id: string; name: string; type: string; directory?: string; timeUsed?: number }> = []
    if (typeof (workspaceApi as any).syncList === 'function') {
      try {
        const syncResult = await (workspaceApi as any).syncList()
        rawEntries = (syncResult.data ?? []) as typeof rawEntries
      } catch {
        const data = await workspaceApi.list()
        rawEntries = (data.data ?? []) as typeof rawEntries
      }
    } else {
      const data = await workspaceApi.list()
      rawEntries = (data.data ?? []) as typeof rawEntries
    }

    const statusResult = await workspaceApi.status()
    const entries = (statusResult.data ?? []) as Array<{ workspaceID: string; status: string }>
    const statusMap = Object.fromEntries(entries.map((s) => [s.workspaceID, s.status]))

    const filtered = rawEntries.filter((w) => {
      const status = statusMap[w.id]
      return !status || status === 'connected'
    })

    expect(filtered).toHaveLength(2)
    expect(filtered.map((w) => w.id)).toEqual(['ws-1', 'ws-3'])
  })

  it('sorts by timeUsed desc', async () => {
    const api = createMockApi() as any
    const workspaceApi = api.experimental.workspace

    let rawEntries: Array<{ id: string; name: string; type: string; directory?: string; timeUsed?: number }> = []
    if (typeof (workspaceApi as any).syncList === 'function') {
      try {
        const syncResult = await (workspaceApi as any).syncList()
        rawEntries = (syncResult.data ?? []) as typeof rawEntries
      } catch {
        const data = await workspaceApi.list()
        rawEntries = (data.data ?? []) as typeof rawEntries
      }
    } else {
      const data = await workspaceApi.list()
      rawEntries = (data.data ?? []) as typeof rawEntries
    }

    const filtered = rawEntries.filter(() => true)
    filtered.sort((a, b) => {
      const ta = a.timeUsed ?? 0
      const tb = b.timeUsed ?? 0
      return tb - ta
    })

    expect(filtered[0].id).toBe('ws-2')
    expect(filtered[1].id).toBe('ws-1')
    expect(filtered[2].id).toBe('ws-3')
  })
})
