import { describe, test, expect, vi, beforeEach } from 'vitest'
import { sweepStaleForgeWorkspaces } from '../../src/workspace/sweep-stale'
import { createFakeForgeClient } from '../helpers/fake-client'
import type { ForgeClient } from '../../src/client/port'
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
    workspaceRemoveImpl?: (...args: any[]) => Promise<void>
    loopsRepoGet?: (projectId: string, loopName: string) => unknown
  }) {
    const pendingTeardowns = createMockPendingTeardowns()
    const logger = createMockLogger()
    const loopsRepo = createMockLoopsRepo({
      get: vi.fn().mockImplementation(options?.loopsRepoGet ?? (() => null)),
    })

    const { client } = createFakeForgeClient({
      workspace: {
        list: async () => (options?.workspaceListResult ?? []) as any,
        remove: options?.workspaceRemoveImpl ?? (async () => {}),
      },
    })

    return { client, pendingTeardowns, logger, loopsRepo }
  }

  test('empty workspace list returns empty report', async () => {
    const { client, pendingTeardowns, logger, loopsRepo } = await createSweepDeps()

    const report = await sweepStaleForgeWorkspaces(
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])
  })

  test('excludes the terminating loop by excludeLoopName', async () => {
    const { client, pendingTeardowns, logger, loopsRepo } = await createSweepDeps({
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
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory, excludeLoopName: 'terminating-loop' },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([])
  })

  test('removes completed workspace (remove-fully)', async () => {
    const removeCalls: any[] = []
    const { client, pendingTeardowns, logger, loopsRepo } = await createSweepDeps({
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
      workspaceRemoveImpl: async () => { removeCalls.push({}) },
      loopsRepoGet: (pid, name) => {
        if (pid === projectId && name === 'completed-loop') {
          return { projectId: pid, loopName: name, status: 'completed' }
        }
        return null
      },
    })

    const report = await sweepStaleForgeWorkspaces(
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([
      { loopName: 'completed-loop', workspaceId: 'ws-completed', action: 'remove-fully' },
    ])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])
    expect(removeCalls.length).toBe(1)

    // Verify pendingTeardowns was set with doRemoveWorktree: true
    expect(pendingTeardowns.set).toHaveBeenCalledWith(
      'completed-loop',
      expect.objectContaining({ doRemoveWorktree: true, doCommit: false }),
    )
  })

  test('removes cancelled workspace (remove-registration-only)', async () => {
    let removeCalledWith: any = null
    const { client, pendingTeardowns, logger, loopsRepo } = await createSweepDeps({
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
      workspaceRemoveImpl: async (params: any) => { removeCalledWith = params },
      loopsRepoGet: (pid, name) => {
        if (pid === projectId && name === 'cancelled-loop') {
          return { projectId: pid, loopName: name, status: 'cancelled' }
        }
        return null
      },
    })

    const report = await sweepStaleForgeWorkspaces(
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([
      { loopName: 'cancelled-loop', workspaceId: 'ws-cancelled', action: 'remove-registration-only' },
    ])
    expect(removeCalledWith).toEqual({ id: 'ws-cancelled' })

    // Verify pendingTeardowns was set with doRemoveWorktree: false
    expect(pendingTeardowns.set).toHaveBeenCalledWith(
      'cancelled-loop',
      expect.objectContaining({ doRemoveWorktree: false, doCommit: false }),
    )
  })

  test('skips running workspace', async () => {
    const { client, pendingTeardowns, logger, loopsRepo } = await createSweepDeps({
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
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([{ workspaceId: 'ws-running', reason: 'running' }])
  })

  test('skips cross-project workspace', async () => {
    const { client, pendingTeardowns, logger, loopsRepo } = await createSweepDeps({
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
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([{ workspaceId: 'ws-cross', reason: 'wrong-project' }])
  })

  test('removes missing-row workspace (remove-fully)', async () => {
    let removeCalledWith: any = null
    const { client, pendingTeardowns, logger, loopsRepo } = await createSweepDeps({
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
      workspaceRemoveImpl: async (params: any) => { removeCalledWith = params },
      loopsRepoGet: vi.fn().mockReturnValue(null),
    })

    const report = await sweepStaleForgeWorkspaces(
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([
      { loopName: 'missing-loop', workspaceId: 'ws-missing', action: 'remove-fully' },
    ])
    expect(removeCalledWith).toEqual({ id: 'ws-missing' })
  })

  test('keeps missing-row TUI workspace during pending attach grace window', async () => {
    const { client, pendingTeardowns, logger, loopsRepo } = await createSweepDeps({
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
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([{ workspaceId: 'ws-pending', reason: 'pending-attach' }])
  })

  test('keeps missing-row freshly created server workspace during pending start grace window', async () => {
    const { client, pendingTeardowns, logger, loopsRepo } = await createSweepDeps({
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
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([{ workspaceId: 'ws-pending-start', reason: 'pending-start' }])
  })

  test('mixed scenario: completed, cancelled, running, missing-row, cross-project', async () => {
    const removeCalls: any[] = []
    const { client, pendingTeardowns, logger, loopsRepo } = await createSweepDeps({
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
      workspaceRemoveImpl: async (params: any) => { removeCalls.push(params) },
      loopsRepoGet: (pid, name) => {
        if (name === 'completed-loop') return { projectId: pid, loopName: name, status: 'completed' }
        if (name === 'cancelled-loop') return { projectId: pid, loopName: name, status: 'cancelled' }
        if (name === 'running-loop') return { projectId: pid, loopName: name, status: 'running' }
        return null
      },
    })

    const report = await sweepStaleForgeWorkspaces(
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
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
    expect(removeCalls.length).toBe(3)
  })

  test('failure isolation: one failed removal does not abort the sweep', async () => {
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

    const { client } = createFakeForgeClient({
      workspace: {
        list: async () => [
          { id: 'ws1', type: 'forge', extra: { loopName: 'loop1', projectDirectory } },
          { id: 'ws2', type: 'forge', extra: { loopName: 'loop2', projectDirectory } },
          { id: 'ws3', type: 'forge', extra: { loopName: 'loop3', projectDirectory } },
        ] as any,
        remove: (async (params: any) => {
          if ((params as any)?.id === 'ws2') throw new Error('boom')
        }) as any,
      },
    })

    const report = await sweepStaleForgeWorkspaces(
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept.length).toBe(2)
    expect(report.failed.length).toBe(1)
    expect(report.failed[0].workspaceId).toBe('ws2')
  })

  test('workspace.list throws returns empty report', async () => {
    const pendingTeardowns = createMockPendingTeardowns()
    const logger = createMockLogger()
    const loopsRepo = createMockLoopsRepo()

    const { client } = createFakeForgeClient({
      workspace: {
        list: async () => { throw new Error('list failed') },
      },
    })

    const report = await sweepStaleForgeWorkspaces(
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])
  })

  test('workspace.remove throws is captured in failed', async () => {
    const pendingTeardowns = createMockPendingTeardowns()
    const logger = createMockLogger()
    const loopsRepo = createMockLoopsRepo({
      get: vi.fn().mockReturnValue({ projectId, loopName: 'failed-loop', status: 'completed' }),
    })

    const { client } = createFakeForgeClient({
      workspace: {
        list: async () => [
          { id: 'ws-failed', type: 'forge', extra: { loopName: 'failed-loop', projectDirectory } },
        ] as any,
        remove: async () => { throw new Error('remove failed') },
      },
    })

    const report = await sweepStaleForgeWorkspaces(
      { client: client as unknown as ForgeClient, pendingTeardowns, logger, loopsRepo },
      { projectId, projectDirectory },
    )

    expect(report.swept).toEqual([])
    expect(report.failed).toEqual([
      { workspaceId: 'ws-failed', loopName: 'failed-loop', error: expect.stringContaining('remove failed') },
    ])
  })
})
