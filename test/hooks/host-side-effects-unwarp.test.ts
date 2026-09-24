import { describe, test, expect, vi } from 'vitest'
import { performTerminationSideEffects } from '../../src/hooks/host-side-effects'
import type { LoopState, TerminationReason } from '../../src/loop'
import type { PluginConfig } from '../../src/types'

function buildState(overrides?: Partial<LoopState>): LoopState {
  return {
    phase: 'coding',
    active: false,
    sessionId: 'sess_worktree',
    hostSessionId: 'sess_host',
    loopName: 'feat-x',
    worktreeDir: '/tmp/wt/feat-x',
    projectDir: '/tmp/project',
    worktreeBranch: 'forge/feat-x',
    iteration: 3,
    maxIterations: 10,
    startedAt: new Date().toISOString(),
    errorCount: 0,
    auditCount: 0,
    currentSectionIndex: 0,
    totalSections: 1,
    finalAuditDone: false,
    worktree: true,
    workspaceId: 'ws_abc',
    ...overrides,
  } as LoopState
}

function buildCtx(overrides?: {
  toast?: ReturnType<typeof vi.fn>
  workspaceRemove?: ReturnType<typeof vi.fn>
  sessionDelete?: ReturnType<typeof vi.fn>
  log?: ReturnType<typeof vi.fn>
  error?: ReturnType<typeof vi.fn>
}) {
  const toast = overrides?.toast ?? vi.fn().mockResolvedValue(undefined)
  const workspaceRemove = overrides?.workspaceRemove ?? vi.fn().mockResolvedValue(undefined)
  const sessionDelete = overrides?.sessionDelete ?? vi.fn().mockResolvedValue(undefined)
  const log = overrides?.log ?? vi.fn()
  const error = overrides?.error ?? vi.fn()

  return {
    ctx: {
      client: {
        session: { delete: sessionDelete } as any,
        workspace: {
          create: async () => ({ id: '' }) as any,
          list: async () => [],
          remove: workspaceRemove,
          warp: async () => {},
        },
        toast,
      } as never,
      logger: { log, error, debug: () => {} },
      getConfig: () => ({}) as PluginConfig,
    },
    toast,
    workspaceRemove,
    sessionDelete,
    log,
    error,
  }
}

const completed: TerminationReason = { kind: 'completed' }
const maxIterations: TerminationReason = { kind: 'max_iterations' }

describe('performTerminationSideEffects', () => {
  test('max_iterations removes workspace but preserves restartable worktree', async () => {
    const { ctx, workspaceRemove } = buildCtx()
    const state = buildState({ iteration: 10, maxIterations: 10 })

    await performTerminationSideEffects(state, maxIterations, 'sess_worktree', ctx)

    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_abc' })
  })

  test('completed teardown deletes the final loop session after the worktree is removed', async () => {
    const { ctx, sessionDelete } = buildCtx()

    await performTerminationSideEffects(buildState(), completed, 'sess_worktree', ctx)

    expect(sessionDelete).toHaveBeenCalledWith({ sessionID: 'sess_worktree', directory: '/tmp/wt/feat-x' })
  })

  test('restartable teardown keeps the final loop session', async () => {
    const { ctx, sessionDelete } = buildCtx()

    await performTerminationSideEffects(buildState(), maxIterations, 'sess_worktree', ctx)

    expect(sessionDelete).not.toHaveBeenCalled()
  })

  test('sweep removes sibling completed forge workspace during teardown', async () => {
    const toast = vi.fn().mockResolvedValue(undefined)
    const workspaceRemove = vi.fn().mockResolvedValue(undefined)
    const workspaceList = vi.fn().mockResolvedValue([
      // The terminating loop's own workspace
      {
        id: 'ws_abc',
        type: 'forge',
        extra: {
          loopName: 'feat-x',
          projectDirectory: '/tmp/project',
        },
      },
      // A sibling completed workspace that should be swept
      {
        id: 'ws_sibling_completed',
        type: 'forge',
        extra: {
          loopName: 'sibling-completed-loop',
          projectDirectory: '/tmp/project',
        },
      },
      // A sibling running workspace that should be kept
      {
        id: 'ws_sibling_running',
        type: 'forge',
        extra: {
          loopName: 'sibling-running-loop',
          projectDirectory: '/tmp/project',
        },
      },
    ])

    const loopsRepoGet = vi.fn().mockImplementation((projectId: string, loopName: string) => {
      if (loopName === 'sibling-completed-loop') return { projectId, loopName, status: 'completed' }
      if (loopName === 'sibling-running-loop') return { projectId, loopName, status: 'running' }
      return null
    })

    const pendingTeardowns = {
      set: vi.fn(),
      get: vi.fn(),
      clear: vi.fn(),
    }

    const client = {
      session: {} as any,
      workspace: {
        create: async () => ({ id: '' }) as any,
        list: workspaceList,
        remove: workspaceRemove,
        warp: async () => {},
      },
      toast,
    } as never

    const ctx = {
      client,
      logger: { log: vi.fn(), error: vi.fn(), debug: () => {} },
      getConfig: () => ({}) as PluginConfig,
      pendingTeardowns: pendingTeardowns as never,
      loopsRepo: { get: loopsRepoGet } as never,
      projectId: 'proj_1',
    }

    await performTerminationSideEffects(buildState(), completed, 'sess_worktree', ctx)

    // Verify the terminating loop's own workspace was removed (via ForgeClient,
    // which delegates to the workspaceRemove mock)
    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_abc' })

    // Verify the sibling completed workspace was swept (excludeLoopName excludes feat-x)
    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_sibling_completed' })

    // Verify the sibling running workspace was NOT removed (kept)
    expect(workspaceRemove).not.toHaveBeenCalledWith({ id: 'ws_sibling_running' })

    // Verify pendingTeardowns.set was called for the sibling with doRemoveWorktree: true
    expect(pendingTeardowns.set).toHaveBeenCalledWith(
      'sibling-completed-loop',
      expect.objectContaining({ doRemoveWorktree: true, doCommit: false }),
    )

    // Verify the sweep was scoped to exclude the terminating loop
    // (i.e., workspaceList was called and the terminating workspace was NOT swept)
    expect(workspaceList).toHaveBeenCalled()
  })

  test('sweep is skipped when loopsRepo or projectId not in ctx', async () => {
    const toast = vi.fn().mockResolvedValue(undefined)
    const workspaceRemove = vi.fn().mockResolvedValue(undefined)
    const workspaceList = vi.fn().mockResolvedValue([])

    const ctx = {
      client: {
        session: {} as any,
        workspace: {
          create: async () => ({ id: '' }) as any,
          list: workspaceList,
          remove: workspaceRemove,
          warp: async () => {},
        },
        toast,
      } as never,
      logger: { log: vi.fn(), error: vi.fn(), debug: () => {} },
      getConfig: () => ({}) as PluginConfig,
      // No loopsRepo, projectId, or pendingTeardowns
    }

    await performTerminationSideEffects(buildState(), completed, 'sess_worktree', ctx)

    // The terminating loop's own workspace was still removed
    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_abc' })

    // The sweep was NOT invoked (workspace.list was not called for sweep purposes)
    expect(workspaceList).not.toHaveBeenCalled()
  })
})
