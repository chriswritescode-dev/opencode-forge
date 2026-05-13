import { describe, test, expect, beforeEach, vi } from 'vitest'

const { mockAttachLoop } = vi.hoisted(() => ({
  mockAttachLoop: vi.fn().mockResolvedValue({ ok: true, loopName: 'test-loop' }),
}))

vi.mock('../../src/services/execution', () => ({
  attachLoopToSession: (...args: unknown[]) => mockAttachLoop(...args),
}))

import { createForgeSessionAttachHook } from '../../src/hooks/forge-session-attach'

describe('createForgeSessionAttachHook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAttachLoop.mockResolvedValue({ ok: true, loopName: 'test-loop' })
  })

  function buildHookDeps(overrides?: {
    workspaceList?: () => Promise<{ data?: unknown[] }>
    plansRepoGetForSession?: (projectId: string, sessionId: string) => { content: string } | null
    loggerErrorSpy?: ReturnType<typeof vi.fn>
  }) {
    const loggerErrorSpy = overrides?.loggerErrorSpy ?? vi.fn()

    return {
      v2: {
        experimental: {
          workspace: {
            list: overrides?.workspaceList ?? vi.fn().mockResolvedValue({ data: [] }),
          },
        },
      },
      execDeps: {
        plansRepo: {
          getForSession: overrides?.plansRepoGetForSession ?? vi.fn().mockReturnValue(null),
        },
        loop: {},
        loopsRepo: {},
      },
      projectId: 'proj_1',
      directory: '/tmp/test',
      logger: {
        log: () => {},
        error: loggerErrorSpy,
        debug: () => {},
      },
    }
  }

  test('session.created event for forge workspace with forgeLoop invokes attachLoopToSession', async () => {
    const getForSessionMock = vi.fn().mockReturnValue({ content: '# Plan\n\nDo stuff.' })
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_forge',
            type: 'forge',
            directory: '/tmp/wt/forge',
            extra: {
              loopName: 'my-feature',
              projectDirectory: '/tmp/wt/forge',
              forgeLoop: {
                loopName: 'my-feature',
                hostSessionId: 'host_sess',
                title: 'My Feature',
                executionModel: 'prov/exec',
                auditorModel: 'prov/aud',
                decomposerMode: 'agent',
                planSource: 'stored',
                maxIterations: 50,
                sandboxEnabled: false,
              },
            },
          },
        ],
      }),
      plansRepoGetForSession: getForSessionMock,
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'new_sess', workspaceID: 'ws_forge' },
        },
      },
    })

    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    const [execDeps, ctx, input] = mockAttachLoop.mock.calls[0]
    expect(ctx.surface).toBe('tui')
    expect(ctx.projectId).toBe('proj_1')
    expect(ctx.directory).toBe('/tmp/wt/forge')
    expect(input.sessionId).toBe('new_sess')
    expect(input.loopName).toBe('my-feature')
    expect(input.displayName).toBe('My Feature')
    expect(input.planText).toBe('# Plan\n\nDo stuff.')
    expect(input.decomposerMode).toBe('agent')
    expect(input.selectSession).toBe(true)
    expect(input.startWatchdog).toBe(true)

    // Verify plan source was resolved from stored plan
    expect(getForSessionMock).toHaveBeenCalledWith('proj_1', 'host_sess')
  })

  test('inline planSource resolves planText inline', async () => {
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_inline',
            type: 'forge',
            directory: '/tmp/wt/inline',
            extra: {
              loopName: 'inline-loop',
              projectDirectory: '/tmp/wt/inline',
              forgeLoop: {
                loopName: 'inline-loop',
                title: 'Inline Loop',
                planSource: 'inline',
                planText: '# Inline Plan\n\nInline stuff.',
              },
            },
          },
        ],
      }),
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'sess_inline', workspaceID: 'ws_inline' },
        },
      },
    })

    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    const [, , input] = mockAttachLoop.mock.calls[0]
    expect(input.planText).toBe('# Inline Plan\n\nInline stuff.')
  })

  test('workspace not found returns silently', async () => {
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({ data: [] }),
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'sess_unknown', workspaceID: 'ws_notfound' },
        },
      },
    })

    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('non-forge workspace returns silently', async () => {
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_worktree',
            type: 'worktree',
            directory: '/tmp/wt/worktree',
            extra: {},
          },
        ],
      }),
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'sess_wt', workspaceID: 'ws_worktree' },
        },
      },
    })

    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('unrelated event type (session.updated) returns silently', async () => {
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_test',
            type: 'forge',
            directory: '/tmp/wt/test',
            extra: {
              loopName: 'test-loop',
              projectDirectory: '/tmp/wt/test',
              forgeLoop: { loopName: 'test-loop' },
            },
          },
        ],
      }),
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.updated',
        properties: {
          info: { id: 'sess_updated', workspaceID: 'ws_test' },
        },
      },
    })

    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('missing sessionId/workspaceId returns silently', async () => {
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_test',
            type: 'forge',
            directory: '/tmp/wt/test',
            extra: {
              loopName: 'test-loop',
              forgeLoop: { loopName: 'test-loop' },
            },
          },
        ],
      }),
    })

    const handler = createForgeSessionAttachHook(deps as any)

    // Missing sessionId
    await handler({
      event: {
        type: 'session.created',
        properties: { info: { workspaceID: 'ws_test' } },
      },
    })
    expect(mockAttachLoop).not.toHaveBeenCalled()

    // Missing workspaceId
    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'sess_x' } },
      },
    })
    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('no forgeLoop extra returns silently', async () => {
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_no_extra',
            type: 'forge',
            directory: '/tmp/wt/no-extra',
            extra: {},
          },
        ],
      }),
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'sess_noextra', workspaceID: 'ws_no_extra' },
        },
      },
    })

    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('stored plan missing logs error and returns without calling attach', async () => {
    const loggerErrorSpy = vi.fn()
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_stored',
            type: 'forge',
            directory: '/tmp/wt/stored',
            extra: {
              loopName: 'stored-loop',
              projectDirectory: '/tmp/wt/stored',
              forgeLoop: {
                loopName: 'stored-loop',
                planSource: 'stored',
                hostSessionId: 'host_sess',
              },
            },
          },
        ],
      }),
      plansRepoGetForSession: vi.fn().mockReturnValue(null),
      loggerErrorSpy,
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'sess_stored', workspaceID: 'ws_stored' },
        },
      },
    })

    expect(mockAttachLoop).not.toHaveBeenCalled()
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[forge-session-attach] plan not found'),
    )
  })

  test('attachLoopToSession throw is caught and logged', async () => {
    const loggerErrorSpy = vi.fn()
    mockAttachLoop.mockRejectedValueOnce(new Error('boom'))
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_err',
            type: 'forge',
            directory: '/tmp/wt/err',
            extra: {
              loopName: 'err-loop',
              projectDirectory: '/tmp/wt/err',
              forgeLoop: {
                loopName: 'err-loop',
                title: 'Err Loop',
                planSource: 'inline',
                planText: '# Plan',
              },
            },
          },
        ],
      }),
      loggerErrorSpy,
    })

    const handler = createForgeSessionAttachHook(deps as any)

    // Should not throw
    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'sess_err', workspaceID: 'ws_err' },
        },
      },
    })

    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[forge-session-attach] attachLoopToSession threw',
      expect.any(Error),
    )
  })
})
