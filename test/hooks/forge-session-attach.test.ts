import { describe, test, expect, beforeEach, vi } from 'vitest'

const mockAttachLoop = vi.fn().mockResolvedValue({ ok: true, loopName: 'test-loop' })

import { createForgeSessionAttachHook, createForgeSessionMessageAttachHook } from '../../src/hooks/forge-session-attach'
import { createFakeForgeClient } from '../helpers/fake-client'

describe('createForgeSessionAttachHook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAttachLoop.mockResolvedValue({ ok: true, loopName: 'test-loop' })
  })

  function buildHookDeps(overrides?: {
    workspaceList?: () => Promise<unknown[]>
    workspaceRemove?: ReturnType<typeof vi.fn>
    tuiPublish?: ReturnType<typeof vi.fn>
    sessionGet?: ReturnType<typeof vi.fn>
    plansRepoGetForSession?: (projectId: string, sessionId: string) => { content: string } | null
    loggerErrorSpy?: ReturnType<typeof vi.fn>
    loggerLogSpy?: ReturnType<typeof vi.fn>
    loopsRepoGet?: ReturnType<typeof vi.fn>
    sandboxManager?: unknown
  }) {
    const loggerErrorSpy = overrides?.loggerErrorSpy ?? vi.fn()
    const loggerLogSpy = overrides?.loggerLogSpy ?? vi.fn()

    const { client } = createFakeForgeClient({
      workspace: {
        list: overrides?.workspaceList ?? (async () => []),
        remove: overrides?.workspaceRemove ?? (async () => {}),
      },
      tui: {
        publish: overrides?.tuiPublish ?? (async () => {}),
      },
      session: {
        get: overrides?.sessionGet ?? (async () => { throw Object.assign(new Error('not found'), { kind: 'not-found' }) }),
      },
    })

    return {
      client,
      execDeps: {
        plansRepo: {
          getForSession: overrides?.plansRepoGetForSession ?? vi.fn().mockReturnValue(null),
        },
        loop: {},
        loopsRepo: {
          get: overrides?.loopsRepoGet ?? vi.fn().mockReturnValue(null),
        },
        pendingTeardowns: {
          set: vi.fn(),
          get: vi.fn(),
          clear: vi.fn(),
        },
        sandboxManager: overrides?.sandboxManager,
      } as any,
      projectId: 'proj_1',
      directory: '/tmp/test',
      logger: {
        log: loggerLogSpy,
        error: loggerErrorSpy,
        debug: () => {},
      },
      attachLoopToSession: (...args: unknown[]) => mockAttachLoop(...args),
    }
  }

  test('session.created event for forge workspace with forgeLoop invokes attachLoopToSession', async () => {
    const getForSessionMock = vi.fn().mockReturnValue({ content: '# Plan\n\nDo stuff.' })
    const loopsRepoGetMock = vi.fn().mockReturnValue(null)
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_forge',
          type: 'forge',
          directory: '/tmp/wt/forge',
          extra: {
            loopName: 'my-feature',
            projectDirectory: '/tmp/wt/forge',
            forgeLoop: {
              hostSessionId: 'host_sess',
              title: 'My Feature',
              executionModel: 'prov/exec',
              auditorModel: 'prov/aud',
              planSource: 'stored',
              maxIterations: 50,
              sandboxEnabled: false,
            },
          },
        },
      ]),
      plansRepoGetForSession: getForSessionMock,
      loopsRepoGet: loopsRepoGetMock,
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
    expect(input.selectSession).toBe(true)
    expect(input.startWatchdog).toBe(true)

    // Verify plan source was resolved from stored plan
    expect(getForSessionMock).toHaveBeenCalledWith('proj_1', 'host_sess')
  })

  test('chat.message fallback attaches TUI-created loop session without re-sending initial prompt', async () => {
    const loopsRepoGetMock = vi.fn().mockReturnValue(null)
    const deps = buildHookDeps({
      sessionGet: vi.fn().mockResolvedValue({
        id: 'new_sess',
        workspaceID: 'ws_inline',
        directory: '/tmp/wt/inline',
        projectID: 'proj_1',
      }),
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_inline',
          type: 'forge',
          directory: '/tmp/wt/inline',
          extra: {
            loopName: 'inline-loop',
            forgeLoop: {
              title: 'Inline Loop',
              planSource: 'inline',
              planText: '# Inline Plan\n\nInline stuff.',
              initialPromptOwner: 'tui',
              pendingAttachStartedAt: Date.now(),
            },
          },
        },
      ]),
      loopsRepoGet: loopsRepoGetMock,
    })

    const handler = createForgeSessionMessageAttachHook(deps as any)

    await handler({ sessionID: 'new_sess' })

    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    const [, ctx, input] = mockAttachLoop.mock.calls[0]
    expect(ctx.surface).toBe('tui')
    expect(ctx.directory).toBe('/tmp/wt/inline')
    expect(input.sessionId).toBe('new_sess')
    expect(input.loopName).toBe('inline-loop')
    expect(input.planText).toBe('# Inline Plan\n\nInline stuff.')
    expect(input.sendInitialPrompt).toBe(false)
    expect(input.selectSession).toBe(false)
    expect(input.startWatchdog).toBe(true)
  })

  test('chat.message fallback restores sandbox for TUI-created loop workspace', async () => {
    const restore = vi.fn().mockResolvedValue(undefined)
    const getActive = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        containerName: 'forge-inline-loop',
        projectDir: '/tmp/wt/inline',
        startedAt: '2026-05-21T14:07:11.000Z',
      })
    const deps = buildHookDeps({
      sandboxManager: { restore, getActive },
      sessionGet: vi.fn().mockResolvedValue({
        id: 'new_sess',
        workspaceID: 'ws_inline',
        directory: '/tmp/wt/inline',
        projectID: 'proj_1',
      }),
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_inline',
          type: 'forge',
          directory: '/tmp/wt/inline',
          extra: {
            loopName: 'inline-loop',
            forgeLoop: {
              title: 'Inline Loop',
              planSource: 'inline',
              planText: '# Inline Plan\n\nInline stuff.',
              initialPromptOwner: 'tui',
              pendingAttachStartedAt: Date.now(),
            },
          },
        },
      ]),
      loopsRepoGet: vi.fn().mockReturnValue(null),
    })

    const handler = createForgeSessionMessageAttachHook(deps as any)

    await handler({ sessionID: 'new_sess' })

    expect(restore).toHaveBeenCalledWith('inline-loop', '/tmp/wt/inline', expect.any(String))
    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    const [, , input] = mockAttachLoop.mock.calls[0]
    expect(input.sandboxEnabled).toBe(true)
    expect(input.sandboxContainer).toBe('forge-inline-loop')
  })

  test('chat.message fallback removes expired pending attach workspace without binding', async () => {
    const workspaceRemove = vi.fn().mockResolvedValue(undefined)
    const tuiPublish = vi.fn().mockResolvedValue(undefined)
    const deps = buildHookDeps({
      workspaceRemove,
      tuiPublish,
      sessionGet: vi.fn().mockResolvedValue({
        id: 'new_sess',
        workspaceID: 'ws_expired',
        directory: '/tmp/wt/expired',
        projectID: 'proj_1',
      }),
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_expired',
          type: 'forge',
          directory: '/tmp/wt/expired',
          extra: {
            loopName: 'expired-loop',
            projectDirectory: '/tmp/wt/expired',
            forgeLoop: {
              title: 'Expired Loop',
              planSource: 'inline',
              planText: '# Inline Plan',
              initialPromptOwner: 'tui',
              pendingAttachStartedAt: Date.now() - (10 * 60 * 1000),
            },
          },
        },
      ]),
    })

    const handler = createForgeSessionMessageAttachHook(deps as any)

    await handler({ sessionID: 'new_sess' })

    expect(mockAttachLoop).not.toHaveBeenCalled()
    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_expired' })
    expect(deps.execDeps.pendingTeardowns.set).toHaveBeenCalledWith(
      'expired-loop',
      expect.objectContaining({ doRemoveWorktree: true, doCommit: false }),
    )
    expect(tuiPublish).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        properties: expect.objectContaining({
          message: expect.stringContaining('attach window expired'),
        }),
      }),
    }))
  })

  test('attach conflict with restartable terminal row removes registration only', async () => {
    const workspaceRemove = vi.fn().mockResolvedValue(undefined)
    const loopsRepoGet = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ projectId: 'proj_1', loopName: 'race-loop', status: 'cancelled' })
    mockAttachLoop.mockResolvedValueOnce({ ok: false, code: 'conflict', message: 'Loop race-loop is terminal' })
    const deps = buildHookDeps({
      workspaceRemove,
      loopsRepoGet,
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_race',
          type: 'forge',
          directory: '/tmp/wt/race',
          extra: {
            loopName: 'race-loop',
            projectDirectory: '/tmp/wt/race',
            forgeLoop: {
              title: 'Race Loop',
              planSource: 'inline',
              planText: '# Plan',
            },
          },
        },
      ]),
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'sess_race', workspaceID: 'ws_race' } },
      },
    })

    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_race' })
    expect(deps.execDeps.pendingTeardowns.set).toHaveBeenCalledWith(
      'race-loop',
      expect.objectContaining({ doRemoveWorktree: false, doCommit: false }),
    )
  })

  test('chat.message fallback refuses terminal row when TUI did not pre-suffix loop name', async () => {
    const loopsRepoGet = vi.fn((projectId: string, loopName: string) => {
      if (projectId !== 'proj_1') return null
      if (loopName === 'inline-loop') return { projectId, loopName, status: 'completed' }
      return null
    })
    const deps = buildHookDeps({
      loopsRepoGet,
      sessionGet: vi.fn().mockResolvedValue({
        id: 'new_sess',
        workspaceID: 'ws_inline',
        directory: '/tmp/wt/inline',
        projectID: 'proj_1',
      }),
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_inline',
          type: 'forge',
          directory: '/tmp/wt/inline',
          extra: {
            loopName: 'inline-loop',
            forgeLoop: {
              title: 'Inline Loop',
              planSource: 'inline',
              planText: '# Inline Plan\n\nInline stuff.',
              initialPromptOwner: 'tui',
            },
          },
        },
      ]),
    })

    const handler = createForgeSessionMessageAttachHook(deps as any)

    await handler({ sessionID: 'new_sess' })

    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('inline planSource resolves planText inline', async () => {
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_inline',
          type: 'forge',
          directory: '/tmp/wt/inline',
          extra: {
            loopName: 'inline-loop',
            projectDirectory: '/tmp/wt/inline',
            forgeLoop: {
              title: 'Inline Loop',
              planSource: 'inline',
              planText: '# Inline Plan\n\nInline stuff.',
            },
          },
        },
      ]),
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
      workspaceList: vi.fn().mockResolvedValue([]),
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
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_worktree',
          type: 'worktree',
          directory: '/tmp/wt/worktree',
          extra: {},
        },
      ]),
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
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_test',
          type: 'forge',
          directory: '/tmp/wt/test',
          extra: {
            loopName: 'test-loop',
            projectDirectory: '/tmp/wt/test',
            forgeLoop: {},
          },
        },
      ]),
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
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_test',
          type: 'forge',
          directory: '/tmp/wt/test',
          extra: {
            loopName: 'test-loop',
            forgeLoop: {},
          },
        },
      ]),
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
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_no_extra',
          type: 'forge',
          directory: '/tmp/wt/no-extra',
          extra: {},
        },
      ]),
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

  test('missing-row workspace with loopName but no forgeLoop config is removed as stale', async () => {
    const workspaceRemove = vi.fn().mockResolvedValue(undefined)
    const tuiPublish = vi.fn().mockResolvedValue(undefined)
    const deps = buildHookDeps({
      workspaceRemove,
      tuiPublish,
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_no_config',
          type: 'forge',
          directory: '/tmp/wt/no-config',
          extra: {
            loopName: 'no-config-loop',
            projectDirectory: '/tmp/wt/no-config',
          },
        },
      ]),
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'sess_no_config', workspaceID: 'ws_no_config' },
        },
      },
    })

    expect(mockAttachLoop).not.toHaveBeenCalled()
    expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_no_config' })
    expect(deps.execDeps.pendingTeardowns.set).toHaveBeenCalledWith(
      'no-config-loop',
      expect.objectContaining({ doRemoveWorktree: true, doCommit: false }),
    )
    expect(tuiPublish).toHaveBeenCalled()
  })

  test('stored plan missing logs error, removes orphan workspace, and publishes toast', async () => {
    const loggerErrorSpy = vi.fn()
    const workspaceRemove = vi.fn().mockResolvedValue(undefined)
    const tuiPublish = vi.fn().mockResolvedValue(undefined)
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_stored',
          type: 'forge',
          directory: '/tmp/wt/stored',
          extra: {
            loopName: 'stored-loop',
            projectDirectory: '/tmp/wt/stored',
            forgeLoop: {
              planSource: 'stored',
              hostSessionId: 'host_sess',
            },
          },
        },
      ]),
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
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_empty_host',
          type: 'forge',
          directory: '/tmp/wt/empty-host',
          extra: {
            loopName: 'empty-host-loop',
            projectDirectory: '/tmp/wt/empty-host',
            forgeLoop: {
              hostSessionId: '',
              title: 'Empty Host',
              planSource: 'stored',
            },
          },
        },
      ]),
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
    const workspaceRemove = vi.fn().mockResolvedValue(undefined)
    const tuiPublish = vi.fn().mockResolvedValue(undefined)
    mockAttachLoop.mockRejectedValueOnce(new Error('boom'))
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_err',
          type: 'forge',
          directory: '/tmp/wt/err',
          extra: {
            loopName: 'err-loop',
            projectDirectory: '/tmp/wt/err',
            forgeLoop: {
              title: 'Err Loop',
              planSource: 'inline',
              planText: '# Plan',
            },
          },
        },
      ]),
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
    const workspaceRemove = vi.fn().mockResolvedValue(undefined)
    const tuiPublish = vi.fn().mockResolvedValue(undefined)
    mockAttachLoop.mockResolvedValueOnce({ ok: false, code: 'prompt_failed', message: 'prompt blew up' })
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_fail',
          type: 'forge',
          directory: '/tmp/wt/fail',
          extra: {
            loopName: 'fail-loop',
            projectDirectory: '/tmp/wt/fail',
            forgeLoop: {
              title: 'Fail Loop',
              planSource: 'inline',
              planText: '# Plan',
            },
          },
        },
      ]),
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
    const workspaceRemove = vi.fn().mockResolvedValue(undefined)
    const tuiPublish = vi.fn().mockResolvedValue(undefined)
    mockAttachLoop.mockResolvedValueOnce({ ok: false, code: 'already_attached', message: 'already attached' })
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_dup',
          type: 'forge',
          directory: '/tmp/wt/dup',
          extra: {
            loopName: 'dup-loop',
            projectDirectory: '/tmp/wt/dup',
            forgeLoop: {
              title: 'Dup Loop',
              planSource: 'inline',
              planText: '# Plan',
            },
          },
        },
      ]),
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
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_forge',
          type: 'forge',
          directory: '/tmp/wt/forge',
          extra: {
            loopName: 'my-feature',
            projectDirectory: '/tmp/wt/forge',
            forgeLoop: {
              hostSessionId: 'host_sess',
              title: 'My Feature',
              executionModel: 'prov/exec',
              auditorModel: 'prov/aud',
              planSource: 'stored',
              maxIterations: 50,
              sandboxEnabled: false,
            },
          },
        },
      ]),
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

  async function expectTerminalLoopRowRefusesReattach(status: 'completed' | 'cancelled' | 'errored' | 'stalled', shouldRemoveWorkspace: boolean) {
    const loopsRepoGetMock = vi.fn().mockReturnValue({
      projectId: 'proj_1',
      loopName: 'restart-loop',
      status,
    })
    const workspaceRemove = vi.fn().mockResolvedValue(undefined)
    const tuiPublish = vi.fn().mockResolvedValue(undefined)
    const loggerLogSpy = vi.fn()

    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_restart',
          type: 'forge',
          directory: '/tmp/wt/restart',
          extra: {
            loopName: 'restart-loop',
            projectDirectory: '/tmp/wt/restart',
            forgeLoop: {
              title: 'Restart',
              planSource: 'inline',
              planText: '# Plan',
            },
          },
        },
      ]),
      loopsRepoGet: loopsRepoGetMock,
      workspaceRemove,
      tuiPublish,
      loggerLogSpy,
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

    expect(mockAttachLoop).not.toHaveBeenCalled()
    expect(workspaceRemove).toHaveBeenCalledTimes(shouldRemoveWorkspace ? 1 : 0)
    if (shouldRemoveWorkspace) {
      expect(workspaceRemove).toHaveBeenCalledWith({ id: 'ws_restart' })
      expect(deps.execDeps.pendingTeardowns.set).toHaveBeenCalledWith(
        'restart-loop',
        expect.objectContaining({
          doRemoveWorktree: status === 'completed',
          doCommit: false,
        }),
      )
    }
    expect(tuiPublish).toHaveBeenCalledTimes(1)
    const expectedMessage = status === 'completed'
      ? 'Loop already completed. Run a new plan to start fresh.'
      : 'in terminal status. Use Loop-status restart to resume.'
    expect(tuiPublish).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        properties: expect.objectContaining({
          title: expect.stringContaining('restart-loop'),
          message: expect.stringContaining(expectedMessage),
          variant: 'error',
        }),
      }),
    }))
  }

  test('terminal loop row (cancelled) refuses re-attach, removes registration, and preserves worktree', async () => {
    await expectTerminalLoopRowRefusesReattach('cancelled', true)
  })

  test('terminal loop row (completed) refuses re-attach and removes orphan workspace', async () => {
    await expectTerminalLoopRowRefusesReattach('completed', true)
  })

  test('terminal loop row (errored) refuses re-attach, removes registration, and preserves worktree', async () => {
    await expectTerminalLoopRowRefusesReattach('errored', true)
  })

  test('terminal loop row (stalled) refuses re-attach, removes registration, and preserves worktree', async () => {
    await expectTerminalLoopRowRefusesReattach('stalled', true)
  })

  test('hook fires for initial workspace session, no-ops for warp-created coding session in same workspace', async () => {
    const loggerErrorSpy = vi.fn()
    const loopsRepoGetMock = vi.fn().mockReturnValue(null)

    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_forge',
          type: 'forge',
          directory: '/tmp/wt/forge',
          extra: {
            loopName: 'my-feature',
            projectDirectory: '/tmp/wt/forge',
            forgeLoop: {
              hostSessionId: 'host_sess',
              title: 'My Feature',
              executionModel: 'prov/exec',
              auditorModel: 'prov/aud',
              planSource: 'stored',
              maxIterations: 50,
              sandboxEnabled: false,
            },
          },
        },
      ]),
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
          info: { id: 'ses_initial', workspaceID: 'ws_forge' },
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
      expect.objectContaining({ sessionId: 'ses_initial' }),
    )
    expect(loggerErrorSpy).not.toHaveBeenCalled()
  })

  test('passes sessionInfo.directory to experimental.workspace.list', async () => {
    const forgeWorkspaceWithForgeLoop = {
      id: 'ws_forge_dir',
      type: 'forge',
      directory: '/tmp/cross-proj',
      extra: {
        loopName: 'cross-loop',
        projectDirectory: '/tmp/cross-proj',
        forgeLoop: {
          hostSessionId: 'host_sess',
          title: 'Cross Project Loop',
          planSource: 'inline',
          planText: '# Plan\n\nCross-project.',
        },
      },
    }
    const workspaceList = vi.fn().mockResolvedValue([forgeWorkspaceWithForgeLoop])
    const deps = buildHookDeps({ workspaceList })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'new_sess', workspaceID: 'ws_forge_dir', directory: '/tmp/cross-proj', projectID: 'proj_other' },
        },
      },
    })

    expect(workspaceList).toHaveBeenCalledWith({ directory: '/tmp/cross-proj' })
    expect(mockAttachLoop).toHaveBeenCalled()
  })

  test('omits directory parameter when sessionInfo.directory is missing', async () => {
    const forgeWorkspaceWithForgeLoop = {
      id: 'ws_forge_nodir',
      type: 'forge',
      directory: '/tmp/same-proj',
      extra: {
        loopName: 'nodir-loop',
        projectDirectory: '/tmp/same-proj',
        forgeLoop: {
          hostSessionId: 'host_sess',
          title: 'No Dir Loop',
          planSource: 'inline',
          planText: '# Plan\n\nNo dir.',
        },
      },
    }
    const workspaceList = vi.fn().mockResolvedValue([forgeWorkspaceWithForgeLoop])
    const deps = buildHookDeps({ workspaceList })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'new_sess_no_dir', workspaceID: 'ws_forge_nodir' },
        },
      },
    })

    expect(workspaceList).toHaveBeenCalledWith(undefined)
    expect(mockAttachLoop).toHaveBeenCalled()
  })

  test('uses sessionInfo.projectID for loopsRepo.get and attachLoopToSession ctx', async () => {
    const loopsRepoGet = vi.fn().mockReturnValue(null)
    const plansRepoGetForSession = vi.fn().mockReturnValue({ content: 'plan text' })
    const workspaceList = vi.fn().mockResolvedValue([
      {
        id: 'ws_forge_pid',
        type: 'forge',
        directory: '/tmp/wt/pid',
        extra: {
          loopName: 'demo',
          projectDirectory: '/tmp/wt/pid',
          forgeLoop: {
            hostSessionId: 'host_sess',
            title: 'Demo Loop',
            planSource: 'stored',
          },
        },
      },
    ])
    const deps = buildHookDeps({
      loopsRepoGet,
      plansRepoGetForSession,
      workspaceList,
    })
    deps.projectId = 'plugin_proj'

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'new_sess', workspaceID: 'ws_forge_pid', directory: '/tmp/wt/pid', projectID: 'session_proj' },
        },
      },
    })

    expect(loopsRepoGet).toHaveBeenCalledWith('session_proj', 'demo')
    expect(plansRepoGetForSession).toHaveBeenCalledWith('session_proj', 'host_sess')
    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    const [, ctx] = mockAttachLoop.mock.calls[0]
    expect(ctx.projectId).toBe('session_proj')
  })

  test('falls back to deps.projectId when sessionInfo.projectID is missing', async () => {
    const loopsRepoGet = vi.fn().mockReturnValue(null)
    const plansRepoGetForSession = vi.fn().mockReturnValue({ content: 'plan text' })
    const workspaceList = vi.fn().mockResolvedValue([
      {
        id: 'ws_forge_fb',
        type: 'forge',
        directory: '/tmp/wt/fb',
        extra: {
          loopName: 'fallback-loop',
          projectDirectory: '/tmp/wt/fb',
          forgeLoop: {
            hostSessionId: 'host_sess',
            title: 'Fallback Loop',
            planSource: 'stored',
          },
        },
      },
    ])
    const deps = buildHookDeps({
      loopsRepoGet,
      plansRepoGetForSession,
      workspaceList,
    })
    deps.projectId = 'plugin_proj'

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'new_sess_fb', workspaceID: 'ws_forge_fb', directory: '/tmp/wt/fb' },
        },
      },
    })

    expect(loopsRepoGet).toHaveBeenCalledWith('plugin_proj', 'fallback-loop')
    expect(plansRepoGetForSession).toHaveBeenCalledWith('plugin_proj', 'host_sess')
    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    const [, ctx] = mockAttachLoop.mock.calls[0]
    expect(ctx.projectId).toBe('plugin_proj')
  })

  test('publishes a tui.toast when workspace is unfindable after retry', async () => {
    const workspaceList = vi.fn().mockResolvedValue([])
    const tuiPublish = vi.fn().mockResolvedValue(undefined)
    const deps = buildHookDeps({ workspaceList, tuiPublish })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'new_sess', workspaceID: 'ws_missing', directory: '/tmp/cross-proj' },
        },
      },
    })

    expect(tuiPublish).toHaveBeenCalledTimes(1)
    expect(tuiPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/tmp/cross-proj',
        body: expect.objectContaining({
          type: 'tui.toast.show',
          properties: expect.objectContaining({
            variant: 'error',
          }),
        }),
      }),
    )
    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('does not publish a toast when sessionInfo.directory is missing', async () => {
    const workspaceList = vi.fn().mockResolvedValue([])
    const tuiPublish = vi.fn().mockResolvedValue(undefined)
    const deps = buildHookDeps({ workspaceList, tuiPublish })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'new_sess_no_dir', workspaceID: 'ws_missing' },
        },
      },
    })

    expect(tuiPublish).not.toHaveBeenCalled()
    expect(mockAttachLoop).not.toHaveBeenCalled()
  })

  test('attach hook prefers inline planText over stored plan when both are available', async () => {
    const plansRepoGetForSession = vi.fn().mockReturnValue({ content: 'STALE_PRIOR_PLAN_TEXT' })
    const deps = buildHookDeps({
      workspaceList: vi.fn().mockResolvedValue([
        {
          id: 'ws_inline_vs_stored',
          type: 'forge',
          directory: '/tmp/wt/inline-vs-stored',
          extra: {
            loopName: 'my-plan',
            projectDirectory: '/tmp/wt/inline-vs-stored',
            forgeLoop: {
              hostSessionId: 'ses_host',
              title: 'My Plan',
              planSource: 'inline',
              planText: 'FRESH_PLAN_TEXT',
            },
          },
        },
      ]),
      plansRepoGetForSession,
    })

    const handler = createForgeSessionAttachHook(deps as any)

    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'new_sess', workspaceID: 'ws_inline_vs_stored' },
        },
      },
    })

    expect(mockAttachLoop).toHaveBeenCalledTimes(1)
    const [, , input] = mockAttachLoop.mock.calls[0]
    expect(input.planText).toBe('FRESH_PLAN_TEXT')

    expect(plansRepoGetForSession).not.toHaveBeenCalled()
  })
})
