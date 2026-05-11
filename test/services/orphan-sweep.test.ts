import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sweepOrphanWorkspaces } from '../../src/loop/orphan-sweep'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

function createMockV2Client(overrides?: Partial<any>): OpencodeClient {
  return {
    session: {
      abort: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockResolvedValue({}),
      messages: vi.fn().mockResolvedValue({}),
      status: vi.fn().mockResolvedValue({}),
      promptAsync: vi.fn().mockResolvedValue({}),
    },
    experimental: {
      workspace: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        remove: vi.fn().mockResolvedValue({}),
      },
      session: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
    },
    tui: {
      publish: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as unknown as OpencodeClient
}

function createMockLoopsRepo(overrides?: Partial<LoopsRepo>): LoopsRepo {
  return {
    insert: vi.fn(),
    get: vi.fn(),
    getLarge: vi.fn(),
    delete: vi.fn(),
    setStatus: vi.fn(),
    setCurrentSessionId: vi.fn(),
    replaceSession: vi.fn(),
    listByStatus: vi.fn().mockReturnValue([]),
    getBySessionId: vi.fn(),
    findPartial: vi.fn(),
    terminate: vi.fn(),
    incrementError: vi.fn(),
    resetError: vi.fn(),
    updatePhase: vi.fn(),
    setPhaseAndResetError: vi.fn(),
    setModelFailed: vi.fn(),
    setLastAuditResult: vi.fn(),
    clearLastAuditResult: vi.fn(),
    setSandboxContainer: vi.fn(),
    clearWorkspaceId: vi.fn(),
    setWorkspaceId: vi.fn(),
    ...overrides,
  } as unknown as LoopsRepo
}

function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

describe('sweepOrphanWorkspaces', () => {
  let mockV2: ReturnType<typeof createMockV2Client>
  let mockLoopsRepo: ReturnType<typeof createMockLoopsRepo>
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    mockV2 = createMockV2Client()
    mockLoopsRepo = createMockLoopsRepo()
    mockLogger = createMockLogger()
  })

  it('removes orphan worktree workspaces', async () => {
    const activeWorkspaceId = 'active-ws-1'
    const orphanWorkspaceId = 'orphan-ws-2'

    mockV2.experimental!.workspace.list = vi.fn().mockResolvedValue({
      data: [
        { id: activeWorkspaceId, type: 'forge', directory: '/tmp/active' },
        { id: orphanWorkspaceId, type: 'forge', directory: '/tmp/orphan' },
        { id: 'other-ws-3', type: 'other-type', directory: '/tmp/other' },
      ],
    })

    mockLoopsRepo.listByStatus = vi.fn().mockReturnValue([
      { workspaceId: activeWorkspaceId } as any,
    ])

    const result = await sweepOrphanWorkspaces({
      v2Client: mockV2,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })

    expect(result.removed).toBe(1)
    expect(result.errors).toEqual([])
    expect(mockV2.experimental!.workspace.remove).toHaveBeenCalledWith({ id: orphanWorkspaceId })
    expect(mockV2.experimental!.workspace.remove).not.toHaveBeenCalledWith({ id: activeWorkspaceId })
  })

  it('deletes sessions in orphan workspace before removing workspace', async () => {
    const orphanWorkspaceId = 'orphan-ws-2'
    const orphanSessionId = 'orphan-session-1'

    mockV2.experimental!.workspace.list = vi.fn().mockResolvedValue({
      data: [
        { id: orphanWorkspaceId, type: 'forge', directory: '/tmp/orphan' },
      ],
    })

    mockLoopsRepo.listByStatus = vi.fn().mockReturnValue([])

    mockV2.experimental!.session!.list = vi.fn().mockResolvedValue({
      data: [{ id: orphanSessionId }],
    })

    await sweepOrphanWorkspaces({
      v2Client: mockV2,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })

    expect(mockV2.session.delete).toHaveBeenCalledWith({
      sessionID: orphanSessionId,
      directory: '/tmp/orphan',
    })
    expect(mockV2.experimental!.workspace.remove).toHaveBeenCalled()
  })

  it('skips duplicate concurrent sweeps for the same workspace', async () => {
    const orphanWorkspaceId = 'orphan-ws-2'
    const orphanSessionId = 'orphan-session-1'
    let resolveSessionListStarted: () => void = () => {}
    const sessionListStarted = new Promise<void>((resolve) => {
      resolveSessionListStarted = resolve
    })

    mockV2.experimental!.workspace.list = vi.fn().mockResolvedValue({
      data: [
        { id: orphanWorkspaceId, type: 'forge', directory: '/tmp/orphan' },
      ],
    })

    mockLoopsRepo.listByStatus = vi.fn().mockReturnValue([])

    mockV2.experimental!.session!.list = vi.fn(async () => {
      resolveSessionListStarted()
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { data: [{ id: orphanSessionId }] }
    }) as any

    const firstSweep = sweepOrphanWorkspaces({
      v2Client: mockV2,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })
    await sessionListStarted

    const secondResult = await sweepOrphanWorkspaces({
      v2Client: mockV2,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })
    const firstResult = await firstSweep

    expect(firstResult.removed).toBe(1)
    expect(secondResult.removed).toBe(0)
    expect(secondResult.errors).toEqual([])
    expect(mockV2.experimental!.session!.list).toHaveBeenCalledTimes(1)
    expect(mockV2.session.delete).toHaveBeenCalledTimes(1)
    expect(mockV2.experimental!.workspace.remove).toHaveBeenCalledTimes(1)
  })

  it('ignores not found errors from already-deleted sessions', async () => {
    const orphanWorkspaceId = 'orphan-ws-2'
    const orphanSessionId = 'orphan-session-1'
    const notFoundError = new Error('NotFoundError')
    notFoundError.name = 'NotFoundError'

    mockV2.experimental!.workspace.list = vi.fn().mockResolvedValue({
      data: [
        { id: orphanWorkspaceId, type: 'forge', directory: '/tmp/orphan' },
      ],
    })

    mockLoopsRepo.listByStatus = vi.fn().mockReturnValue([])

    mockV2.experimental!.session!.list = vi.fn().mockResolvedValue({
      data: [{ id: orphanSessionId }],
    })
    mockV2.session.delete = vi.fn().mockRejectedValue(notFoundError)

    const result = await sweepOrphanWorkspaces({
      v2Client: mockV2,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })

    expect(result.removed).toBe(1)
    expect(result.errors).toEqual([])
    expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('failed to delete session'), notFoundError)
    expect(mockV2.experimental!.workspace.remove).toHaveBeenCalledWith({ id: orphanWorkspaceId })
  })

  it('skips workspaces that are in active set', async () => {
    const activeWorkspaceId = 'active-ws-1'

    mockV2.experimental!.workspace.list = vi.fn().mockResolvedValue({
      data: [
        { id: activeWorkspaceId, type: 'forge', directory: '/tmp/active' },
      ],
    })

    mockLoopsRepo.listByStatus = vi.fn().mockReturnValue([
      { workspaceId: activeWorkspaceId } as any,
    ])

    const result = await sweepOrphanWorkspaces({
      v2Client: mockV2,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })

    expect(result.removed).toBe(0)
    expect(mockV2.experimental!.workspace.remove).not.toHaveBeenCalled()
  })

  it('skips non-worktree workspaces', async () => {
    mockV2.experimental!.workspace.list = vi.fn().mockResolvedValue({
      data: [
        { id: 'other-ws-1', type: 'other-type', directory: '/tmp/other' },
        { id: 'other-ws-2', type: 'another-type', directory: '/tmp/another' },
      ],
    })

    mockLoopsRepo.listByStatus = vi.fn().mockReturnValue([])

    const result = await sweepOrphanWorkspaces({
      v2Client: mockV2,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })

    expect(result.removed).toBe(0)
    expect(mockV2.experimental!.workspace.remove).not.toHaveBeenCalled()
  })

  it('continues when session deletion fails', async () => {
    const orphanWorkspaceId = 'orphan-ws-2'
    const orphanSessionId = 'orphan-session-1'

    mockV2.experimental!.workspace.list = vi.fn().mockResolvedValue({
      data: [
        { id: orphanWorkspaceId, type: 'forge', directory: '/tmp/orphan' },
      ],
    })

    mockLoopsRepo.listByStatus = vi.fn().mockReturnValue([])

    mockV2.experimental!.session!.list = vi.fn().mockResolvedValue({
      data: [{ id: orphanSessionId }],
    })

    mockV2.session.delete = vi.fn().mockRejectedValue(new Error('session delete failed'))

    const result = await sweepOrphanWorkspaces({
      v2Client: mockV2,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })

    expect(result.removed).toBe(1)
    expect(result.errors).toContainEqual(expect.stringContaining('Failed to delete session'))
    expect(mockV2.experimental!.workspace.remove).toHaveBeenCalledWith({ id: orphanWorkspaceId })
  })

  it('continues when workspace removal fails', async () => {
    const orphanWorkspaceId = 'orphan-ws-2'

    mockV2.experimental!.workspace.list = vi.fn().mockResolvedValue({
      data: [
        { id: orphanWorkspaceId, type: 'forge', directory: '/tmp/orphan' },
      ],
    })

    mockLoopsRepo.listByStatus = vi.fn().mockReturnValue([])

    mockV2.experimental!.workspace.remove = vi.fn().mockRejectedValue(new Error('workspace remove failed'))

    const result = await sweepOrphanWorkspaces({
      v2Client: mockV2,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })

    expect(result.removed).toBe(0)
    expect(result.errors).toContainEqual(expect.stringContaining('Failed to remove workspace'))
  })

  it('returns empty result when experimental.workspace.list is not available', async () => {
    mockV2.experimental!.workspace.list = undefined as any

    const result = await sweepOrphanWorkspaces({
      v2Client: mockV2,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })

    expect(result.removed).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('skips session deletion when experimental.session.list is not available', async () => {
    const orphanWorkspaceId = 'orphan-ws-2'

    const v2WithoutSessionList = createMockV2Client({
      experimental: {
        workspace: {
          list: vi.fn().mockResolvedValue({
            data: [
              { id: orphanWorkspaceId, type: 'forge', directory: '/tmp/orphan' },
            ],
          }),
          remove: vi.fn().mockResolvedValue({}),
        },
        session: undefined,
      },
    })

    mockLoopsRepo.listByStatus = vi.fn().mockReturnValue([])

    const result = await sweepOrphanWorkspaces({
      v2Client: v2WithoutSessionList,
      loopsRepo: mockLoopsRepo,
      projectId: 'project-123',
      logger: mockLogger,
    })

    expect(result.removed).toBe(1)
    expect(v2WithoutSessionList.session.delete).not.toHaveBeenCalled()
  })
})
