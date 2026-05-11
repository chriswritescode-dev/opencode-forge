import { describe, it, expect, vi, beforeEach } from 'vitest'
import { bindSessionToWorkspace, createBuiltinWorktreeWorkspace } from '../../src/workspace/forge-worktree'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

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

  function mockV2Client(overrides?: { syncList?: any; create?: any; syncStart?: any }) {
    return {
      ...(overrides?.syncStart !== undefined
        ? { sync: { start: overrides.syncStart } }
        : {}),
      experimental: {
        workspace: {
          create: overrides?.create ?? vi.fn().mockResolvedValue({
            data: { id: 'ws-1', directory: '/tmp/wt-1', branch: 'feature/x' },
          }),
          ...(overrides?.syncList !== undefined
            ? { syncList: overrides.syncList }
            : {}),
        },
      },
    } as unknown as OpencodeClient
  }

  describe('createBuiltinWorktreeWorkspace', () => {
    it('happy path calls syncList exactly once after successful create', async () => {
      const createMock = vi.fn().mockResolvedValue({
        data: { id: 'ws-1', directory: '/tmp/wt-1', branch: 'feature/x' },
      })
      const syncListMock = vi.fn().mockResolvedValue({ data: [{ id: 'ws-1' }] })

      const client = mockV2Client({ create: createMock, syncList: syncListMock })

      const result = await createBuiltinWorktreeWorkspace(
        client,
        { loopName: 'foo' },
        logger,
      )

      expect(result).toEqual({ workspaceId: 'ws-1', directory: '/tmp/wt-1', branch: 'feature/x' })
      expect(syncListMock).toHaveBeenCalledTimes(1)
      expect(createMock.mock.invocationCallOrder[0]).toBeLessThan(
        syncListMock.mock.invocationCallOrder[0],
      )
    })

    it('syncList failure does not break the create result', async () => {
      const createMock = vi.fn().mockResolvedValue({
        data: { id: 'ws-2', directory: '/tmp/wt-2', branch: 'feature/y' },
      })
      const syncListMock = vi.fn().mockRejectedValue(new Error('host syncList unavailable'))

      const client = mockV2Client({ create: createMock, syncList: syncListMock })

      const result = await createBuiltinWorktreeWorkspace(
        client,
        { loopName: 'bar' },
        logger,
      )

      expect(result).toEqual({ workspaceId: 'ws-2', directory: '/tmp/wt-2', branch: 'feature/y' })
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('syncList'),
        expect.anything(),
      )
    })

    it('syncList is NOT called when create fails', async () => {
      const createMock = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
      const syncListMock = vi.fn()

      const client = mockV2Client({ create: createMock, syncList: syncListMock })

      const result = await createBuiltinWorktreeWorkspace(
        client,
        { loopName: 'baz' },
        logger,
      )

      expect(result).toBeNull()
      expect(syncListMock).not.toHaveBeenCalled()
    })

    it('graceful when syncList is not available on the SDK', async () => {
      const createMock = vi.fn().mockResolvedValue({
        data: { id: 'ws-3', directory: '/tmp/wt-3', branch: 'feature/z' },
      })

      const client = {
        experimental: {
          workspace: {
            create: createMock,
          },
        },
      } as unknown as OpencodeClient

      const result = await createBuiltinWorktreeWorkspace(
        client,
        { loopName: 'qux' },
        logger,
      )

      expect(result).toEqual({ workspaceId: 'ws-3', directory: '/tmp/wt-3', branch: 'feature/z' })
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('syncList'),
      )
    })

    it('recovery path calls syncList after successful re-provisioning (regression)', async () => {
      const createMock = vi.fn().mockResolvedValue({
        data: { id: 'ws-recovered', directory: '/tmp/wt-recovered', branch: 'fix/recovery' },
      })
      const syncListMock = vi.fn().mockResolvedValue({ data: [{ id: 'ws-recovered' }] })

      const client = mockV2Client({ create: createMock, syncList: syncListMock })

      const result = await createBuiltinWorktreeWorkspace(
        client,
        { loopName: 'recovery-loop', directory: '/tmp/wt-recovered' },
        logger,
      )

      expect(result).toEqual({ workspaceId: 'ws-recovered', directory: '/tmp/wt-recovered', branch: 'fix/recovery' })
      expect(syncListMock).toHaveBeenCalledTimes(1)
    })

    it('matches TUI create flow by keeping workspace create and syncList unscoped', async () => {
      const createMock = vi.fn().mockResolvedValue({
        data: { id: 'ws-scoped', directory: '/tmp/wt-scoped', branch: 'feature/scoped' },
      })
      const syncListMock = vi.fn().mockResolvedValue({ data: undefined })

      const client = mockV2Client({ create: createMock, syncList: syncListMock })

      const result = await createBuiltinWorktreeWorkspace(
        client,
        { loopName: 'scoped-loop', directory: '/tmp/project' },
        logger,
      )

      expect(result).toEqual({ workspaceId: 'ws-scoped', directory: '/tmp/wt-scoped', branch: 'feature/scoped' })
      expect(createMock).toHaveBeenCalledWith({ type: 'forge', branch: null, extra: { loopName: 'scoped-loop' } })
      expect(syncListMock).toHaveBeenCalledWith()
    })

    it('starts workspace sync after successful create and syncList', async () => {
      const createMock = vi.fn().mockResolvedValue({
        data: { id: 'ws-sync', directory: '/tmp/wt-sync', branch: 'feature/sync' },
      })
      const syncListMock = vi.fn().mockResolvedValue({ data: undefined })
      const syncStartMock = vi.fn().mockResolvedValue({ data: true })

      const client = mockV2Client({ create: createMock, syncList: syncListMock, syncStart: syncStartMock })

      const result = await createBuiltinWorktreeWorkspace(
        client,
        { loopName: 'sync-loop' },
        logger,
      )

      expect(result).toEqual({ workspaceId: 'ws-sync', directory: '/tmp/wt-sync', branch: 'feature/sync' })
      expect(syncStartMock).toHaveBeenCalledTimes(1)
      expect(syncListMock.mock.invocationCallOrder[0]).toBeLessThan(
        syncStartMock.mock.invocationCallOrder[0],
      )
    })
  })
})

describe('bindSessionToWorkspace', () => {
  it('matches Warp dialog by warping without directory scope', async () => {
    const warpMock = vi.fn().mockResolvedValue({ data: {}, error: null })
    const client = {
      experimental: {
        workspace: {
          warp: warpMock,
        },
      },
    } as unknown as OpencodeClient

    await bindSessionToWorkspace(client, 'ws-1', 'sess-1', createMockLogger())

    expect(warpMock).toHaveBeenCalledWith({
      id: 'ws-1',
      sessionID: 'sess-1',
    })
  })

  it('starts workspace sync after successful warp binding', async () => {
    const warpMock = vi.fn().mockResolvedValue({ data: {}, error: null })
    const syncStartMock = vi.fn().mockResolvedValue({ data: true })
    const client = {
      sync: {
        start: syncStartMock,
      },
      experimental: {
        workspace: {
          warp: warpMock,
        },
      },
    } as unknown as OpencodeClient

    await bindSessionToWorkspace(client, 'ws-1', 'sess-1', createMockLogger())

    expect(syncStartMock).toHaveBeenCalledTimes(1)
    expect(warpMock.mock.invocationCallOrder[0]).toBeLessThan(
      syncStartMock.mock.invocationCallOrder[0],
    )
  })

  it('checks workspace list and status after successful warp binding', async () => {
    const warpMock = vi.fn().mockResolvedValue({ data: {}, error: null })
    const listMock = vi.fn().mockResolvedValue({ data: [{ id: 'ws-1' }] })
    const statusMock = vi.fn().mockResolvedValue({ data: [{ workspaceID: 'ws-1', status: 'connected' }] })
    const logger = createMockLogger()
    const client = {
      experimental: {
        workspace: {
          warp: warpMock,
          list: listMock,
          status: statusMock,
        },
      },
    } as unknown as OpencodeClient

    await bindSessionToWorkspace(client, 'ws-1', 'sess-1', logger)

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(statusMock).toHaveBeenCalledTimes(1)
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('listed=true status=connected'),
    )
  })
})
