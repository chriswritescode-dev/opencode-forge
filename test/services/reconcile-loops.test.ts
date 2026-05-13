import { describe, test, expect, beforeEach, vi } from 'vitest'

const { mockAttachLoop } = vi.hoisted(() => ({
  mockAttachLoop: vi.fn(),
}))

vi.mock('../../src/services/execution', () => ({
  attachLoopToSession: mockAttachLoop,
}))

import { reconcileForgeWorkspaceLoops } from '../../src/services/reconcile-loops'

describe('reconcileForgeWorkspaceLoops', () => {
  beforeEach(() => {
    mockAttachLoop.mockReset()
    mockAttachLoop.mockResolvedValue({ ok: true, loopName: 'test' })
  })

  function buildDeps(overrides?: {
    workspaceList?: ReturnType<typeof vi.fn>
    sessionList?: ReturnType<typeof vi.fn>
    loopsRepoGet?: ReturnType<typeof vi.fn>
    plansRepoGetForSession?: ReturnType<typeof vi.fn>
    loggerErrorSpy?: ReturnType<typeof vi.fn>
    loggerLogSpy?: ReturnType<typeof vi.fn>
  }) {
    const loggerErrorSpy = overrides?.loggerErrorSpy ?? vi.fn()
    const loggerLogSpy = overrides?.loggerLogSpy ?? vi.fn()

    return {
      v2: {
        experimental: {
          workspace: {
            list: overrides?.workspaceList ?? vi.fn().mockResolvedValue({ data: [] }),
          },
        },
        session: {
          list: overrides?.sessionList ?? vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      execDeps: {
        plansRepo: {
          getForSession: overrides?.plansRepoGetForSession ?? vi.fn().mockReturnValue(null),
        },
        loopsRepo: {
          get: overrides?.loopsRepoGet ?? vi.fn().mockReturnValue(null),
        },
      },
      projectId: 'proj_1',
      directory: '/tmp/test',
      logger: {
        log: loggerLogSpy,
        error: loggerErrorSpy,
        debug: () => {},
      },
    }
  }

  test('no forge workspaces: returns without attaching', async () => {
    const deps = buildDeps({})
    await reconcileForgeWorkspaceLoops(deps as any)
    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('forge workspace with no forgeLoop extra: skipped', async () => {
    const deps = buildDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [{ id: 'ws_a', type: 'forge', directory: '/tmp/a', extra: {} }],
      }),
    })
    await reconcileForgeWorkspaceLoops(deps as any)
    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('forge workspace with running loop row: skipped', async () => {
    const loopsRepoGet = vi.fn().mockReturnValue({ projectId: 'proj_1', loopName: 'l1', status: 'running' })
    const deps = buildDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_a',
            type: 'forge',
            directory: '/tmp/a',
            extra: { forgeLoop: { loopName: 'l1', planSource: 'inline', planText: '# Plan' } },
          },
        ],
      }),
      loopsRepoGet,
    })
    await reconcileForgeWorkspaceLoops(deps as any)
    expect(mockAttachLoop).not.toHaveBeenCalled()
    expect(loopsRepoGet).toHaveBeenCalledWith('proj_1', 'l1')
  })

  test('forge workspace with terminal loop row (cancelled): attaches new loop', async () => {
    const loopsRepoGet = vi.fn().mockReturnValue({ projectId: 'proj_1', loopName: 'l1', status: 'cancelled' })
    const sessionList = vi.fn().mockResolvedValue({
      data: [{ id: 'ses_revive', workspaceID: 'ws_a' }],
    })
    const deps = buildDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_a',
            type: 'forge',
            directory: '/tmp/wt/a',
            extra: { forgeLoop: { loopName: 'l1', planSource: 'inline', planText: '# Plan' } },
          },
        ],
      }),
      sessionList,
      loopsRepoGet,
    })
    await reconcileForgeWorkspaceLoops(deps as any)
    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    expect(mockAttachLoop.mock.calls[0][2].sessionId).toBe('ses_revive')
  })

  test('inline plan: attaches using planText and most-recent session', async () => {
    const sessionList = vi.fn().mockResolvedValue({
      data: [
        { id: 'ses_newest', workspaceID: 'ws_a', time: { updated: 200 } },
        { id: 'ses_older', workspaceID: 'ws_a', time: { updated: 100 } },
      ],
    })
    const deps = buildDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_a',
            type: 'forge',
            directory: '/tmp/wt/a',
            extra: {
              forgeLoop: {
                loopName: 'inline-loop',
                title: 'Inline',
                planSource: 'inline',
                planText: '# Inline Plan',
                executionModel: 'prov/exec',
                auditorModel: 'prov/aud',
              },
            },
          },
        ],
      }),
      sessionList,
    })

    await reconcileForgeWorkspaceLoops(deps as any)

    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    const [, ctx, input] = mockAttachLoop.mock.calls[0]
    expect(ctx).toMatchObject({ surface: 'tui', projectId: 'proj_1', directory: '/tmp/wt/a' })
    expect(input).toMatchObject({
      sessionId: 'ses_newest',
      workspaceId: 'ws_a',
      loopName: 'inline-loop',
      displayName: 'Inline',
      planText: '# Inline Plan',
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
    })
  })

  test('stored plan with hostSessionId: looks up plansRepo by hostSessionId', async () => {
    const sessionList = vi.fn().mockResolvedValue({
      data: [{ id: 'ses_event', workspaceID: 'ws_a', time: { updated: 100 } }],
    })
    const plansRepoGetForSession = vi.fn().mockReturnValue({ content: '# Stored Plan' })
    const deps = buildDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_a',
            type: 'forge',
            directory: '/tmp/wt/a',
            extra: {
              forgeLoop: {
                loopName: 'stored-loop',
                hostSessionId: 'host_sess',
                planSource: 'stored',
              },
            },
          },
        ],
      }),
      sessionList,
      plansRepoGetForSession,
    })

    await reconcileForgeWorkspaceLoops(deps as any)

    expect(plansRepoGetForSession).toHaveBeenCalledWith('proj_1', 'host_sess')
    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    expect(mockAttachLoop.mock.calls[0][2].planText).toBe('# Stored Plan')
    expect(mockAttachLoop.mock.calls[0][2].hostSessionId).toBe('host_sess')
  })

  test('stored plan with empty hostSessionId falls back to session id', async () => {
    const sessionList = vi.fn().mockResolvedValue({
      data: [{ id: 'ses_fallback', workspaceID: 'ws_a', time: { updated: 100 } }],
    })
    const plansRepoGetForSession = vi.fn().mockReturnValue({ content: '# Fallback Plan' })
    const deps = buildDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_a',
            type: 'forge',
            directory: '/tmp/wt/a',
            extra: {
              forgeLoop: {
                loopName: 'fallback-loop',
                hostSessionId: '',
                planSource: 'stored',
              },
            },
          },
        ],
      }),
      sessionList,
      plansRepoGetForSession,
    })

    await reconcileForgeWorkspaceLoops(deps as any)

    expect(plansRepoGetForSession).toHaveBeenCalledWith('proj_1', 'ses_fallback')
    expect(mockAttachLoop.mock.calls[0][2].hostSessionId).toBe('ses_fallback')
  })

  test('no sessions in workspace: skipped without attach', async () => {
    const sessionList = vi.fn().mockResolvedValue({ data: [] })
    const deps = buildDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_a',
            type: 'forge',
            directory: '/tmp/wt/a',
            extra: { forgeLoop: { loopName: 'empty-loop', planSource: 'inline', planText: '# X' } },
          },
        ],
      }),
      sessionList,
    })

    await reconcileForgeWorkspaceLoops(deps as any)
    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('stored plan missing in plansRepo: skipped without attach', async () => {
    const sessionList = vi.fn().mockResolvedValue({
      data: [{ id: 'ses_x', workspaceID: 'ws_a', time: { updated: 100 } }],
    })
    const deps = buildDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_a',
            type: 'forge',
            directory: '/tmp/wt/a',
            extra: {
              forgeLoop: {
                loopName: 'orphan-stored',
                hostSessionId: 'host_missing',
                planSource: 'stored',
              },
            },
          },
        ],
      }),
      sessionList,
      plansRepoGetForSession: vi.fn().mockReturnValue(null),
    })

    await reconcileForgeWorkspaceLoops(deps as any)
    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('multiple forge workspaces processed independently', async () => {
    const sessionList = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: 'ses_a', workspaceID: 'ws_a' }] })
      .mockResolvedValueOnce({ data: [{ id: 'ses_b', workspaceID: 'ws_b' }] })

    const deps = buildDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_a',
            type: 'forge',
            directory: '/tmp/wt/a',
            extra: { forgeLoop: { loopName: 'loop-a', planSource: 'inline', planText: '# A' } },
          },
          {
            id: 'ws_b',
            type: 'forge',
            directory: '/tmp/wt/b',
            extra: { forgeLoop: { loopName: 'loop-b', planSource: 'inline', planText: '# B' } },
          },
        ],
      }),
      sessionList,
    })

    await reconcileForgeWorkspaceLoops(deps as any)
    expect(mockAttachLoop).toHaveBeenCalledTimes(2)
  })

  test('non-forge workspaces ignored', async () => {
    const deps = buildDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          { id: 'ws_a', type: 'worktree', directory: '/tmp/a', extra: { forgeLoop: { loopName: 'l1' } } },
          { id: 'ws_b', type: 'local', directory: '/tmp/b' },
        ],
      }),
    })
    await reconcileForgeWorkspaceLoops(deps as any)
    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

})
