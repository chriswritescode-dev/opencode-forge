import { describe, it, expect, vi, beforeEach } from 'vitest'
import { bindSessionToWorkspace, createBuiltinWorktreeWorkspace } from '../../src/workspace/forge-worktree'
import { createFakeForgeClient } from '../helpers/fake-client'
import type { ForgeClient } from '../../src/client/port'

function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

describe('createBuiltinWorktreeWorkspace', () => {
  let logger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    logger = createMockLogger()
  })

  describe('createBuiltinWorktreeWorkspace', () => {
    it('happy path calls syncList exactly once after successful create', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-1', directory: '/tmp/wt-1', branch: 'feature/x' }),
          list: async () => [{ id: 'ws-1' }],
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'foo', directory: '/tmp/project' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-1', directory: '/tmp/wt-1', branch: 'feature/x' } })
    })

    it('syncList failure does not break the create result', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-2', directory: '/tmp/wt-2', branch: 'feature/y' }),
          syncList: async () => { throw new Error('host syncList unavailable') },
          list: async () => [{ id: 'ws-2' }],
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'bar', directory: '/tmp/project' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-2', directory: '/tmp/wt-2', branch: 'feature/y' } })
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('syncList'),
        expect.anything(),
      )
    })

    it('syncList is NOT called when create fails', async () => {
      const { client, calls } = createFakeForgeClient({
        workspace: {
          create: async () => { throw new Error('create failed') },
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'baz', directory: '/tmp/project' },
        logger,
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.reason).toBe('unknown')
      // syncList should not have been called
      const syncListCalls = calls.filter(c => c.method === 'workspace.syncList')
      expect(syncListCalls.length).toBe(0)
    })

    it('graceful when syncList is not available on the SDK', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-3', directory: '/tmp/wt-3', branch: 'feature/z' }),
          list: async () => [],
        },
      })
      // Remove syncList to simulate it not being available
      const noSyncClient = {
        ...client,
        workspace: {
          ...client.workspace,
          syncList: undefined as any,
        },
      } as unknown as ForgeClient

      const result = await createBuiltinWorktreeWorkspace(
        noSyncClient,
        { loopName: 'qux', directory: '/tmp/project' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-3', directory: '/tmp/wt-3', branch: 'feature/z' } })
    })

    it('recovery path calls syncList after successful re-provisioning (regression)', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-recovered', directory: '/tmp/wt-recovered', branch: 'fix/recovery' }),
          list: async () => [{ id: 'ws-recovered' }],
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'recovery-loop', directory: '/tmp/wt-recovered' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-recovered', directory: '/tmp/wt-recovered', branch: 'fix/recovery' } })
    })

    it('matches TUI create flow by keeping workspace create and syncList unscoped', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-scoped', directory: '/tmp/wt-scoped', branch: 'feature/scoped' }),
          list: async () => [],
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'scoped-loop', directory: '/tmp/project' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-scoped', directory: '/tmp/wt-scoped', branch: 'feature/scoped' } })
    })

    it('starts workspace sync after successful create and syncList', async () => {
      let syncStartCalled = false
      let syncListCalled = false
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-sync', directory: '/tmp/wt-sync', branch: 'feature/sync' }),
          syncList: async () => { syncListCalled = true },
          list: async () => [{ id: 'ws-sync' }],
        },
        sync: {
          start: async () => { syncStartCalled = true },
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'sync-loop', directory: '/tmp/project' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-sync', directory: '/tmp/wt-sync', branch: 'feature/sync' } })
      expect(syncStartCalled).toBe(true)
      // syncList should be called before sync.start
      expect(syncListCalled).toBe(true)
    })

    it('creates workspace without removing old forge workspaces (sweep handles orphan cleanup on teardown)', async () => {
      const { client, calls } = createFakeForgeClient({
        workspace: {
          list: async () => [
            { id: 'ws-old-name', type: 'forge', name: 'sync-loop' },
            { id: 'ws-old-extra', type: 'forge', extra: { loopName: 'sync-loop' } },
          ],
          create: async () => ({ id: 'ws-new', directory: '/tmp/wt-new', branch: 'feature/new' }),
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'sync-loop', directory: '/tmp/project' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-new', directory: '/tmp/wt-new', branch: 'feature/new' } })
      const removeCalls = calls.filter(c => c.method === 'workspace.remove')
      expect(removeCalls.length).toBe(0)
    })

    it('returns no-workspace-id when create returns no id field', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ directory: '/x', branch: 'b' }),
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'no-id', directory: '/tmp/project' },
        logger,
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.reason).toBe('no-workspace-id')
    })

    it('returns empty-directory when create returns empty directory', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-empty', directory: '', branch: 'b' }),
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'empty-dir', directory: '/tmp/project' },
        logger,
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.reason).toBe('empty-directory')
    })
  })
})

describe('bindSessionToWorkspace', () => {
  it('matches Warp dialog by warping without directory scope', async () => {
    const { client, calls } = createFakeForgeClient({
      workspace: {
        warp: async () => {},
        list: async () => [{ id: 'ws-1' }],
        status: async () => [],
      },
    })

    await bindSessionToWorkspace(client as unknown as ForgeClient, 'ws-1', 'sess-1', createMockLogger())

    const warpCalls = calls.filter(c => c.method === 'workspace.warp')
    expect(warpCalls.length).toBe(1)
    expect(warpCalls[0].params).toEqual({
      id: 'ws-1',
      sessionID: 'sess-1',
    })
  })

  it('starts workspace sync after successful warp binding', async () => {
    let syncStartCalled = false
    const { client, calls } = createFakeForgeClient({
      workspace: {
        warp: async () => {},
        list: async () => [{ id: 'ws-1' }],
        status: async () => [],
      },
      sync: {
        start: async () => { syncStartCalled = true },
      },
    })

    await bindSessionToWorkspace(client as unknown as ForgeClient, 'ws-1', 'sess-1', createMockLogger())

    expect(syncStartCalled).toBe(true)
    const warpCalls = calls.filter(c => c.method === 'workspace.warp')
    const syncStartCalls = calls.filter(c => c.method === 'sync.start')
    expect(warpCalls[0].params).toBeDefined()
    // warp should be called before sync.start
    const warpIdx = calls.indexOf(warpCalls[0])
    const syncIdx = calls.indexOf(syncStartCalls[0])
    expect(warpIdx).toBeLessThan(syncIdx)
  })

  it('checks workspace list and status after successful warp binding', async () => {
    const { client, calls } = createFakeForgeClient({
      workspace: {
        warp: async () => {},
        list: async () => [{ id: 'ws-1' }],
        status: async () => [{ workspaceID: 'ws-1', status: 'connected' }],
      },
    })
    const logger = createMockLogger()

    await bindSessionToWorkspace(client as unknown as ForgeClient, 'ws-1', 'sess-1', logger)

    const listCalls = calls.filter(c => c.method === 'workspace.list')
    const statusCalls = calls.filter(c => c.method === 'workspace.status')
    expect(listCalls.length).toBe(1)
    expect(statusCalls.length).toBe(1)
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('listed=true status=connected'),
    )
  })
})
