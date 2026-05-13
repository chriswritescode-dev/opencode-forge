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
    workspaceRemove?: ReturnType<typeof vi.fn>
    tuiPublish?: ReturnType<typeof vi.fn>
    plansRepoGetForSession?: (projectId: string, sessionId: string) => { content: string } | null
    loggerErrorSpy?: ReturnType<typeof vi.fn>
    loggerLogSpy?: ReturnType<typeof vi.fn>
    loopsRepoGet?: ReturnType<typeof vi.fn>
  }) {
    const loggerErrorSpy = overrides?.loggerErrorSpy ?? vi.fn()
    const loggerLogSpy = overrides?.loggerLogSpy ?? vi.fn()

    return {
      v2: {
        experimental: {
          workspace: {
            list: overrides?.workspaceList ?? vi.fn().mockResolvedValue({ data: [] }),
            remove: overrides?.workspaceRemove ?? vi.fn().mockResolvedValue({ data: {} }),
          },
        },
        tui: {
          publish: overrides?.tuiPublish ?? vi.fn().mockResolvedValue({ data: {} }),
        },
      },
      execDeps: {
        plansRepo: {
          getForSession: overrides?.plansRepoGetForSession ?? vi.fn().mockReturnValue(null),
        },
        loop: {},
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

  test('stored plan missing logs error, removes orphan workspace, and publishes toast', async () => {
    const loggerErrorSpy = vi.fn()
    const workspaceRemove = vi.fn().mockResolvedValue({ data: {} })
    const tuiPublish = vi.fn().mockResolvedValue({ data: {} })
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
      workspaceRemove,
      tuiPublish,
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
    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_stored' })
    expect(tuiPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/tmp/wt/stored',
        body: expect.objectContaining({
          type: 'tui.toast.show',
          properties: expect.objectContaining({
            variant: 'error',
            title: expect.stringContaining('stored-loop'),
          }),
        }),
      }),
    )
  })

  test('empty-string cfg.hostSessionId falls through to event sessionId for plan lookup', async () => {
    const plansRepoGetForSession = vi.fn().mockReturnValue({ content: '# Plan\n\nFrom event session.' })
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_empty_host',
            type: 'forge',
            directory: '/tmp/wt/empty-host',
            extra: {
              loopName: 'empty-host-loop',
              projectDirectory: '/tmp/wt/empty-host',
              forgeLoop: {
                loopName: 'empty-host-loop',
                hostSessionId: '',
                title: 'Empty Host',
                planSource: 'stored',
              },
            },
          },
        ],
      }),
      plansRepoGetForSession,
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'sess_event', workspaceID: 'ws_empty_host' },
        },
      },
    })

    expect(plansRepoGetForSession).toHaveBeenCalledWith('proj_1', 'sess_event')
    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    const [, , input] = mockAttachLoop.mock.calls[0]
    expect(input.hostSessionId).toBe('sess_event')
    expect(input.planText).toBe('# Plan\n\nFrom event session.')
  })

  test('attachLoopToSession throw is caught, logged, and orphan workspace removed', async () => {
    const loggerErrorSpy = vi.fn()
    const workspaceRemove = vi.fn().mockResolvedValue({ data: {} })
    const tuiPublish = vi.fn().mockResolvedValue({ data: {} })
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
      workspaceRemove,
      tuiPublish,
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
    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_err' })
    expect(tuiPublish).toHaveBeenCalled()
  })

  test('attachLoopToSession returns ok:false (non-already_attached) triggers orphan cleanup', async () => {
    const workspaceRemove = vi.fn().mockResolvedValue({ data: {} })
    const tuiPublish = vi.fn().mockResolvedValue({ data: {} })
    mockAttachLoop.mockResolvedValueOnce({ ok: false, code: 'prompt_failed', message: 'prompt blew up' })
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_fail',
            type: 'forge',
            directory: '/tmp/wt/fail',
            extra: {
              loopName: 'fail-loop',
              projectDirectory: '/tmp/wt/fail',
              forgeLoop: {
                loopName: 'fail-loop',
                title: 'Fail Loop',
                planSource: 'inline',
                planText: '# Plan',
              },
            },
          },
        ],
      }),
      workspaceRemove,
      tuiPublish,
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'sess_fail', workspaceID: 'ws_fail' },
        },
      },
    })

    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_fail' })
    expect(tuiPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          properties: expect.objectContaining({
            message: expect.stringContaining('prompt blew up'),
            variant: 'error',
          }),
        }),
      }),
    )
  })

  test('attachLoopToSession returns already_attached does NOT remove workspace', async () => {
    const workspaceRemove = vi.fn().mockResolvedValue({ data: {} })
    const tuiPublish = vi.fn().mockResolvedValue({ data: {} })
    mockAttachLoop.mockResolvedValueOnce({ ok: false, code: 'already_attached', message: 'already attached' })
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_dup',
            type: 'forge',
            directory: '/tmp/wt/dup',
            extra: {
              loopName: 'dup-loop',
              projectDirectory: '/tmp/wt/dup',
              forgeLoop: {
                loopName: 'dup-loop',
                title: 'Dup Loop',
                planSource: 'inline',
                planText: '# Plan',
              },
            },
          },
        ],
      }),
      workspaceRemove,
      tuiPublish,
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'sess_dup', workspaceID: 'ws_dup' },
        },
      },
    })

    expect(workspaceRemove).not.toHaveBeenCalled()
    expect(tuiPublish).not.toHaveBeenCalled()
  })

  test('second session.created for same workspace does not re-call attachLoopToSession (idempotency)', async () => {
    const loggerErrorSpy = vi.fn()
    const loopsRepoGetMock = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ projectId: 'proj_1', loopName: 'my-feature', status: 'running' })

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
      plansRepoGetForSession: vi.fn().mockReturnValue({ content: '# Plan\n\nDo stuff.' }),
      loopsRepoGet: loopsRepoGetMock,
      loggerErrorSpy,
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'ses_first', workspaceID: 'ws_forge' },
        },
      },
    })

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'ses_second', workspaceID: 'ws_forge' },
        },
      },
    })

    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    expect(mockAttachLoop).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surface: 'tui' }),
      expect.objectContaining({ sessionId: 'ses_first' }),
    )
    expect(loggerErrorSpy).not.toHaveBeenCalled()
  })

  test('terminal loop row (cancelled) does NOT block re-attach for new session', async () => {
    const loopsRepoGetMock = vi.fn().mockReturnValue({
      projectId: 'proj_1',
      loopName: 'restart-loop',
      status: 'cancelled',
    })

    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ws_restart',
            type: 'forge',
            directory: '/tmp/wt/restart',
            extra: {
              loopName: 'restart-loop',
              projectDirectory: '/tmp/wt/restart',
              forgeLoop: {
                loopName: 'restart-loop',
                title: 'Restart',
                planSource: 'inline',
                planText: '# Plan',
              },
            },
          },
        ],
      }),
      loopsRepoGet: loopsRepoGetMock,
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'ses_restart', workspaceID: 'ws_restart' },
        },
      },
    })

    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    expect(mockAttachLoop.mock.calls[0][2].sessionId).toBe('ses_restart')
  })

  test('hook fires for initial workspace session, no-ops for warp-created coding session in same workspace', async () => {
    const loggerErrorSpy = vi.fn()
    const loopsRepoGetMock = vi.fn().mockReturnValue(null)

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
      plansRepoGetForSession: vi.fn().mockReturnValue({ content: '# Plan\n\nDo stuff.' }),
      loopsRepoGet: loopsRepoGetMock,
      loggerErrorSpy,
    })

    // Simulate real INSERT side-effect: first call to attachLoopToSession mutates loopsRepo.get
    mockAttachLoop.mockImplementationOnce(async () => {
      loopsRepoGetMock.mockReturnValue({ projectId: 'proj_1', loopName: 'my-feature', status: 'running' })
      return { ok: true, loopName: 'my-feature' }
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'ses_decomposer', workspaceID: 'ws_forge' },
        },
      },
    })

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'ses_warp_coding', workspaceID: 'ws_forge' },
        },
      },
    })

    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    expect(mockAttachLoop).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surface: 'tui' }),
      expect.objectContaining({ sessionId: 'ses_decomposer' }),
    )
    expect(loggerErrorSpy).not.toHaveBeenCalled()
  })
})
