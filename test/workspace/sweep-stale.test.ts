import { describe, test, expect, vi, beforeEach } from 'vitest'
import { sweepStaleForgeWorkspaces } from '../../src/workspace/sweep-stale'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { PendingTeardownRegistry } from '../../src/workspace/pending-teardown'

function createMockLoopsRepo(overrides?: Partial<LoopsRepo>): LoopsRepo {
  return {
    insert: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    getLarge: vi.fn(),
    getBySessionId: vi.fn(),
    listByStatus: vi.fn(),
    listAll: vi.fn(),
    updatePhase: vi.fn(),
    updateIteration: vi.fn(),
    incrementError: vi.fn(),
    resetError: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setWorkspaceId: vi.fn(),
    clearWorkspaceId: vi.fn(),
    setModelFailed: vi.fn(),
    setLastAuditResult: vi.fn(),
    clearLastAuditResult: vi.fn(),
    setSandboxContainer: vi.fn(),
    setStatus: vi.fn(),
    setPhaseAndResetError: vi.fn(),
    replaceSession: vi.fn(),
    restart: vi.fn(),
    terminate: vi.fn(),
    delete: vi.fn(),
    findPartial: vi.fn(),
    setCurrentSectionIndex: vi.fn(),
    setTotalSections: vi.fn(),
    setFinalAuditDone: vi.fn(),
    ...overrides,
  }
}

function createMockPendingTeardowns(): PendingTeardownRegistry & { set: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> } {
  const setFn = vi.fn()
  const clearFn = vi.fn()
  return {
    set: setFn,
    get: vi.fn(),
    clear: clearFn,
  }
}

function createMockLogger(): { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

describe('sweepStaleForgeWorkspaces', () => {
  const projectId = 'test-project'
  const projectDirectory = '/tmp/test-project'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function createSweepDeps(options?: {
    workspaceListResult?: Array<{ id: string; type?: string; extra?: Record<string, unknown> }>
    workspaceRemoveResult?: { data?: unknown; error?: unknown }
    loopsRepoGet?: (projectId: string, loopName: string) => unknown
  }) {
    const workspaceRemove = vi.fn().mockResolvedValue(options?.workspaceRemoveResult ?? { data: {} })
    const pendingTeardowns = createMockPendingTeardowns()
    const logger = createMockLogger()
    const loopsRepo = createMockLoopsRepo({
      get: vi.fn().mockImplementation(options?.loopsRepoGet ?? (() => null)),
    })

    const v2 = {
      experimental: {
        workspace: {
          list: vi.fn().mockResolvedValue({ data: options?.workspaceListResult ?? [] }),
          remove: workspaceRemove,
        },
      },
    }

    return { v2, pendingTeardowns, logger, loopsRepo, workspaceRemove }
  }

  test('empty workspace list returns empty report', async () => {
    const { v2, pendingTeardowns, logger, loopsRepo } = await createSweepDeps()

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])
  })

  test('excludes the terminating loop by excludeLoopName', async () => {
    const { v2, pendingTeardowns, logger, loopsRepo, workspaceRemove } = await createSweepDeps({
      workspaceListResult: [
        {
          id: 'ws-excluded',
          type: 'forge',
          extra: {
            loopName: 'terminating-loop',
            projectDirectory,
          },
        },
      ],
    })

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory, excludeLoopName: 'terminating-loop' },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([])
    expect(workspaceRemove).not.toHaveBeenCalled()
  })

  test('removes completed workspace (remove-fully)', async () => {
    const { v2, pendingTeardowns, logger, loopsRepo, workspaceRemove } = await createSweepDeps({
      workspaceListResult: [
        {
          id: 'ws-completed',
          type: 'forge',
          extra: {
            loopName: 'completed-loop',
            projectDirectory,
          },
        },
      ],
      loopsRepoGet: (pid, name) => {
        if (pid === projectId && name === 'completed-loop') {
          return { projectId: pid, loopName: name, status: 'completed' }
        }
        return null
      },
    })

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([
      { loopName: 'completed-loop', workspaceId: 'ws-completed', action: 'remove-fully' },
    ])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])
    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws-completed' })

    // Verify pendingTeardowns was set with doRemoveWorktree: true
    expect(pendingTeardowns.set).toHaveBeenCalledWith(
      'completed-loop',
      expect.objectContaining({ doRemoveWorktree: true, doCommit: false }),
    )
  })

  test('removes cancelled workspace (remove-registration-only)', async () => {
    const { v2, pendingTeardowns, logger, loopsRepo, workspaceRemove } = await createSweepDeps({
      workspaceListResult: [
        {
          id: 'ws-cancelled',
          type: 'forge',
          extra: {
            loopName: 'cancelled-loop',
            projectDirectory,
          },
        },
      ],
      loopsRepoGet: (pid, name) => {
        if (pid === projectId && name === 'cancelled-loop') {
          return { projectId: pid, loopName: name, status: 'cancelled' }
        }
        return null
      },
    })

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([
      { loopName: 'cancelled-loop', workspaceId: 'ws-cancelled', action: 'remove-registration-only' },
    ])
    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws-cancelled' })

    // Verify pendingTeardowns was set with doRemoveWorktree: false
    expect(pendingTeardowns.set).toHaveBeenCalledWith(
      'cancelled-loop',
      expect.objectContaining({ doRemoveWorktree: false, doCommit: false }),
    )
  })

  test('skips running workspace', async () => {
    const { v2, pendingTeardowns, logger, loopsRepo, workspaceRemove } = await createSweepDeps({
      workspaceListResult: [
        {
          id: 'ws-running',
          type: 'forge',
          extra: {
            loopName: 'running-loop',
            projectDirectory,
          },
        },
      ],
      loopsRepoGet: (pid, name) => {
        if (pid === projectId && name === 'running-loop') {
          return { projectId: pid, loopName: name, status: 'running' }
        }
        return null
      },
    })

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([{ workspaceId: 'ws-running', reason: 'running' }])
    expect(workspaceRemove).not.toHaveBeenCalled()
  })

  test('skips cross-project workspace', async () => {
    const { v2, pendingTeardowns, logger, loopsRepo, workspaceRemove } = await createSweepDeps({
      workspaceListResult: [
        {
          id: 'ws-cross',
          type: 'forge',
          extra: {
            loopName: 'cross-loop',
            projectDirectory: '/tmp/other-project',
          },
        },
      ],
    })

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([{ workspaceId: 'ws-cross', reason: 'wrong-project' }])
    expect(workspaceRemove).not.toHaveBeenCalled()
  })

  test('removes missing-row workspace (remove-fully)', async () => {
    const { v2, pendingTeardowns, logger, loopsRepo, workspaceRemove } = await createSweepDeps({
      workspaceListResult: [
        {
          id: 'ws-missing',
          type: 'forge',
          extra: {
            loopName: 'missing-loop',
            projectDirectory,
          },
        },
      ],
      loopsRepoGet: vi.fn().mockReturnValue(null),
    })

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([
      { loopName: 'missing-loop', workspaceId: 'ws-missing', action: 'remove-fully' },
    ])
    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws-missing' })
  })

  test('keeps missing-row TUI workspace during pending attach grace window', async () => {
    const { v2, pendingTeardowns, logger, loopsRepo, workspaceRemove } = await createSweepDeps({
      workspaceListResult: [
        {
          id: 'ws-pending',
          type: 'forge',
          extra: {
            loopName: 'pending-loop',
            projectDirectory,
            forgeLoop: {
              initialPromptOwner: 'tui',
              pendingAttachStartedAt: Date.now(),
            },
          },
        },
      ],
      loopsRepoGet: vi.fn().mockReturnValue(null),
    })

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([{ workspaceId: 'ws-pending', reason: 'pending-attach' }])
    expect(workspaceRemove).not.toHaveBeenCalled()
  })

  test('keeps missing-row freshly created server workspace during pending start grace window', async () => {
    const { v2, pendingTeardowns, logger, loopsRepo, workspaceRemove } = await createSweepDeps({
      workspaceListResult: [
        {
          id: 'ws-pending-start',
          type: 'forge',
          extra: {
            loopName: 'pending-start-loop',
            projectDirectory,
            workspaceCreatedAt: Date.now(),
          },
        },
      ],
      loopsRepoGet: vi.fn().mockReturnValue(null),
    })

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([{ workspaceId: 'ws-pending-start', reason: 'pending-start' }])
    expect(workspaceRemove).not.toHaveBeenCalled()
  })

  test('mixed scenario: completed, cancelled, running, missing-row, cross-project', async () => {
    const { v2, pendingTeardowns, logger, loopsRepo, workspaceRemove } = await createSweepDeps({
      workspaceListResult: [
        {
          id: 'ws-completed',
          type: 'forge',
          extra: { loopName: 'completed-loop', projectDirectory },
        },
        {
          id: 'ws-cancelled',
          type: 'forge',
          extra: { loopName: 'cancelled-loop', projectDirectory },
        },
        {
          id: 'ws-running',
          type: 'forge',
          extra: { loopName: 'running-loop', projectDirectory },
        },
        {
          id: 'ws-missing',
          type: 'forge',
          extra: { loopName: 'missing-loop', projectDirectory },
        },
        {
          id: 'ws-cross',
          type: 'forge',
          extra: { loopName: 'cross-loop', projectDirectory: '/tmp/other' },
        },
      ],
      loopsRepoGet: (pid, name) => {
        if (name === 'completed-loop') return { projectId: pid, loopName: name, status: 'completed' }
        if (name === 'cancelled-loop') return { projectId: pid, loopName: name, status: 'cancelled' }
        if (name === 'running-loop') return { projectId: pid, loopName: name, status: 'running' }
        return null
      },
    })

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept.length).toBe(3)
    expect(report.swept).toEqual(
      expect.arrayContaining([
        { loopName: 'completed-loop', workspaceId: 'ws-completed', action: 'remove-fully' },
        { loopName: 'cancelled-loop', workspaceId: 'ws-cancelled', action: 'remove-registration-only' },
        { loopName: 'missing-loop', workspaceId: 'ws-missing', action: 'remove-fully' },
      ]),
    )
    expect(report.skipped.length).toBe(2)
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { workspaceId: 'ws-running', reason: 'running' },
        { workspaceId: 'ws-cross', reason: 'wrong-project' },
      ]),
    )
    expect(report.failed).toEqual([])
    expect(workspaceRemove).toHaveBeenCalledTimes(3)
  })

  test('failure isolation: one failed removal does not abort the sweep', async () => {
    const workspaceRemove = vi.fn()
      .mockResolvedValueOnce({ data: {} }) // first succeeds
      .mockRejectedValueOnce(new Error('boom')) // second fails
      .mockResolvedValueOnce({ data: {} }) // third succeeds

    const pendingTeardowns = createMockPendingTeardowns()
    const logger = createMockLogger()
    const loopsRepo = createMockLoopsRepo({
      get: vi.fn().mockImplementation((pid, name) => {
        if (name === 'loop1') return { projectId: pid, loopName: name, status: 'completed' }
        if (name === 'loop2') return { projectId: pid, loopName: name, status: 'completed' }
        if (name === 'loop3') return { projectId: pid, loopName: name, status: 'completed' }
        return null
      }),
    })

    const v2 = {
      experimental: {
        workspace: {
          list: vi.fn().mockResolvedValue({
            data: [
              { id: 'ws1', type: 'forge', extra: { loopName: 'loop1', projectDirectory } },
              { id: 'ws2', type: 'forge', extra: { loopName: 'loop2', projectDirectory } },
              { id: 'ws3', type: 'forge', extra: { loopName: 'loop3', projectDirectory } },
            ],
          }),
          remove: workspaceRemove,
        },
      },
    }

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept.length).toBe(2)
    expect(report.failed.length).toBe(1)
    expect(report.failed[0].workspaceId).toBe('ws2')
    expect(workspaceRemove).toHaveBeenCalledTimes(3)
  })

  test('workspace.list not available returns empty report', async () => {
    const pendingTeardowns = createMockPendingTeardowns()
    const logger = createMockLogger()
    const loopsRepo = createMockLoopsRepo()

    const v2 = {
      experimental: {
        workspace: {},
      },
    }

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('experimental.workspace.list not available'),
    )
  })

  test('workspace.list throws returns empty report', async () => {
    const pendingTeardowns = createMockPendingTeardowns()
    const logger = createMockLogger()
    const loopsRepo = createMockLoopsRepo()

    const v2 = {
      experimental: {
        workspace: {
          list: vi.fn().mockRejectedValue(new Error('list failed')),
        },
      },
    }

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])
  })

  test('workspace.remove returns error is captured in failed', async () => {
    const workspaceRemove = vi.fn().mockResolvedValue({ error: 'remove failed' })
    const pendingTeardowns = createMockPendingTeardowns()
    const logger = createMockLogger()
    const loopsRepo = createMockLoopsRepo({
      get: vi.fn().mockReturnValue({ projectId, loopName: 'failed-loop', status: 'completed' }),
    })

    const v2 = {
      experimental: {
        workspace: {
          list: vi.fn().mockResolvedValue({
            data: [
              { id: 'ws-failed', type: 'forge', extra: { loopName: 'failed-loop', projectDirectory } },
            ],
          }),
          remove: workspaceRemove,
        },
      },
    }

    const report = await sweepStaleForgeWorkspaces(
      { v2: v2 as any, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.failed).toEqual([
      { workspaceId: 'ws-failed', loopName: 'failed-loop', error: expect.stringContaining('remove failed') },
    ])
  })
})
