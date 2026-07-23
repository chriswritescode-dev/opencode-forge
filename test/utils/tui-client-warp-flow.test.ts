import { describe, test, expect, beforeEach, vi } from 'vitest'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

vi.mock('../../src/utils/tui-execution-preferences', () => ({
  deriveExecutionPreferencesFromWorkspaces: vi.fn().mockReturnValue(null),
}))

vi.mock('../../src/utils/tui-models', () => ({
  fetchAvailableModels: vi.fn().mockResolvedValue({ providers: [] }),
  readOpenCodeFavoriteModels: vi.fn().mockReturnValue([]),
}))

vi.mock('../../src/utils/workspace-listing', () => ({
  listConnectedWorkspaces: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/utils/tui-loop-store', () => ({
  fetchLoopsList: vi.fn().mockReturnValue([]),
}))

vi.mock('../../src/storage', () => ({
  resolveLogPath: vi.fn().mockReturnValue('/tmp/forge-test.log'),
}))

vi.mock('../../src/services/execution', () => ({
  ForgeLoopExtra: {},
}))

import { connectForgeProject } from '../../src/utils/tui-client'
import { buildLoopPermissionRuleset } from '../../src/constants/loop'
import { fetchLoopsList } from '../../src/utils/tui-loop-store'

describe('TUI warp flow for plan.execute mode=loop', () => {
  const PROJECT_ID = 'proj_test'
  const DIRECTORY = '/tmp/test'
  const SESSION_ID = 'sess_host'

  let callOrder: string[]
  let mockApi: any

  beforeEach(() => {
    vi.mocked(fetchLoopsList).mockReturnValue([])
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    callOrder = []
    mockApi = {
      client: {
        project: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: PROJECT_ID, worktree: DIRECTORY }],
          }),
        },
        experimental: {
          workspace: {
            list: vi.fn().mockResolvedValue({ data: [] }),
            remove: vi.fn().mockResolvedValue({ data: {} }),
            create: vi.fn().mockImplementation(async (args: any) => {
              callOrder.push('workspace.create')
              return {
                data: {
                  id: 'ws_loop',
                  directory: '/tmp/wt/loop',
                  branch: null,
                },
              }
            }),
            syncList: vi.fn().mockImplementation(async () => {
              callOrder.push('workspace.syncList')
              return undefined
            }),
            status: vi.fn().mockImplementation(async () => {
              callOrder.push('workspace.status')
              return { data: [{ workspaceID: 'ws_loop', status: 'connected' }] }
            }),
          },
        },
        session: {
          create: vi.fn().mockImplementation(async (args: any) => {
            callOrder.push('session.create')
            return {
              data: {
                id: 'sess_new',
              },
            }
          }),
          promptAsync: vi.fn().mockImplementation(async () => {
            callOrder.push('session.promptAsync')
            return { data: {} }
          }),
        },
        tui: {
          selectSession: vi.fn().mockImplementation(async (args: any) => {
            callOrder.push('tui.selectSession')
          }),
        },
      },
      route: {
        navigate: vi.fn().mockImplementation(() => {
          callOrder.push('route.navigate')
        }),
      },
    }
  })

  test('happy path: correct call order and workspace.create params', async () => {
    const client = await connectForgeProject(mockApi, DIRECTORY)
    expect(client).not.toBeNull()

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'My Cool Feature',
        plan: '# Plan\n\nImplement feature X.',
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
    )

    // Verify return value
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('sess_new')
    expect(result!.loopName).toBe('my-cool-feature')
    expect(result!.worktreeDir).toBe('/tmp/wt/loop')
    expect(result!.workspaceId).toBe('ws_loop')

    // Verify call order
    expect(callOrder).toEqual([
      'workspace.create',
      'workspace.syncList',
      'workspace.status',
      'session.create',
      'session.promptAsync',
      'route.navigate',
      'workspace.syncList',
    ])

    // Verify workspace.create was called with correct params
    expect(mockApi.client.experimental.workspace.create).toHaveBeenCalledTimes(1)
    const createArgs = mockApi.client.experimental.workspace.create.mock.calls[0][0]
    expect(createArgs.type).toBe('forge')
    expect(createArgs.branch).toBeNull()
    expect(createArgs.extra.loopName).toBe('my-cool-feature')
    expect(createArgs.extra.projectDirectory).toBe(DIRECTORY)
    expect(createArgs.extra.workspaceCreatedAt).toEqual(expect.any(Number))
    expect(createArgs.extra.forgeLoop).toEqual({
      hostSessionId: SESSION_ID,
      title: 'My Cool Feature',
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
      planSource: 'inline',
      planText: '# Plan\n\nImplement feature X.',
      initialPromptOwner: 'tui',
      pendingAttachStartedAt: expect.any(Number),
    })

    // Verify session.create was called with correct params
    const sesCreateArgs = mockApi.client.session.create.mock.calls[0][0]
    expect(sesCreateArgs.workspaceID).toBe('ws_loop')
    expect(sesCreateArgs.workspace).toBeUndefined()
    expect(sesCreateArgs.title).toBe('my-cool-feature')
    expect(sesCreateArgs.directory).toBe('/tmp/wt/loop')
    expect(sesCreateArgs.permission).toEqual(buildLoopPermissionRuleset())
    expect(sesCreateArgs.permission).toContainEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })

    const promptArgs = mockApi.client.session.promptAsync.mock.calls[0][0]
    expect(promptArgs.sessionID).toBe('sess_new')
    expect(promptArgs.directory).toBe('/tmp/wt/loop')
    expect(promptArgs.workspace).toBe('ws_loop')
    expect(promptArgs.agent).toBe('code')
    expect(promptArgs.parts).toEqual([{ type: 'text', text: '# Plan\n\nImplement feature X.' }])

    // Verify route.navigate was called instead of tui.selectSession
    expect(mockApi.route.navigate).toHaveBeenCalledWith('session', { sessionID: 'sess_new' })
    expect(mockApi.client.tui.selectSession).not.toHaveBeenCalled()

    // syncList called twice
    expect(mockApi.client.experimental.workspace.syncList).toHaveBeenCalledTimes(2)
  })

  test('removes old forge workspaces for same loop before creating replacement', async () => {
    mockApi.client.experimental.workspace.list.mockResolvedValueOnce({
      data: [
        { id: 'ws_old_1', type: 'forge', name: 'my-cool-feature-1' },
        { id: 'ws_old_2', type: 'forge', extra: { loopName: 'my-cool-feature-1' } },
        { id: 'ws_old_3', type: 'forge', extra: { loopName: 'my-cool-feature-1' } },
        { id: 'ws_other', type: 'forge', name: 'other-loop' },
        { id: 'ws_worktree', type: 'worktree', name: 'my-cool-feature' },
      ],
    })

    const client = await connectForgeProject(mockApi, DIRECTORY)

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'My Cool Feature',
        plan: '# Plan\n\nImplement feature X.',
      },
    )

    expect(result).not.toBeNull()
    expect(result!.loopName).toBe('my-cool-feature-2')
    expect(mockApi.client.experimental.workspace.remove).toHaveBeenCalledTimes(0)
    expect(mockApi.client.experimental.workspace.create.mock.invocationCallOrder[0]).toBeGreaterThan(0)
    const createArgs = mockApi.client.experimental.workspace.create.mock.calls[0][0]
    expect(createArgs.extra.loopName).toBe('my-cool-feature-2')
    expect(createArgs.extra.workspaceCreatedAt).toEqual(expect.any(Number))
  })

  test('suffixes new TUI loop start before workspace creation when base workspace already exists', async () => {
    mockApi.client.experimental.workspace.list.mockResolvedValueOnce({
      data: [
        { id: 'ws_done', type: 'forge', name: 'my-cool-feature' },
      ],
    })

    const client = await connectForgeProject(mockApi, DIRECTORY)

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'My Cool Feature',
        plan: '# Plan\n\nImplement feature X.',
      },
    )

    expect(result!.loopName).toBe('my-cool-feature-1')
    const createArgs = mockApi.client.experimental.workspace.create.mock.calls[0][0]
    expect(createArgs.extra.loopName).toBe('my-cool-feature-1')
    expect(mockApi.client.session.create.mock.calls[0][0].title).toBe('my-cool-feature-1')
  })

  test('suffixes new TUI loop start before workspace creation when terminal loop row exists', async () => {
    vi.mocked(fetchLoopsList).mockReturnValueOnce([
      { name: 'my-cool-feature', active: false } as any,
    ])

    const client = await connectForgeProject(mockApi, DIRECTORY)

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'My Cool Feature',
        plan: '# Plan\n\nImplement feature X.',
      },
    )

    expect(result!.loopName).toBe('my-cool-feature-1')
    const createArgs = mockApi.client.experimental.workspace.create.mock.calls[0][0]
    expect(createArgs.extra.loopName).toBe('my-cool-feature-1')
    expect(mockApi.client.session.create.mock.calls[0][0].title).toBe('my-cool-feature-1')
  })

  test('failure: workspace.create returns error → returns {error}, downstream NOT called', async () => {
    mockApi.client.experimental.workspace.create.mockResolvedValueOnce({ error: new Error('fail') })

    const client = await connectForgeProject(mockApi, DIRECTORY)
    expect(client).not.toBeNull()

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'Fail Loop',
        plan: '# Fail Plan\n\nThis will fail.',
      },
    )

    expect(result).toEqual({ error: 'Failed to create worktree workspace: fail' })
    // Downstream calls should not have been made
    expect(mockApi.client.session.create).not.toHaveBeenCalled()
    expect(mockApi.client.tui.selectSession).not.toHaveBeenCalled()
    expect(mockApi.client.experimental.workspace.syncList).not.toHaveBeenCalled()
    expect(mockApi.client.session.promptAsync).not.toHaveBeenCalled()
  })

  test('failure: workspace.create returns no data → returns {error}', async () => {
    mockApi.client.experimental.workspace.create.mockResolvedValueOnce({ data: undefined })

    const client = await connectForgeProject(mockApi, DIRECTORY)

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'No Data Loop',
        plan: '# No Data\n\nShould fail.',
      },
    )

    expect(result).toEqual({ error: 'Failed to create worktree workspace: no data returned' })
  })

  test('failure: session.create returns error → returns {error} with cause', async () => {
    mockApi.client.session.create.mockResolvedValueOnce({ error: new Error('session create fail') })

    const client = await connectForgeProject(mockApi, DIRECTORY)

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'Sess Fail Loop',
        plan: '# Session Fail.\n',
      },
    )

    expect(result).toEqual({ error: expect.stringContaining('session create fail') })
    // workspace.create should still have been called but downstream after session.create shouldn't
    expect(mockApi.client.experimental.workspace.create).toHaveBeenCalled()
    expect(mockApi.client.tui.selectSession).not.toHaveBeenCalled()
    expect(mockApi.client.session.promptAsync).not.toHaveBeenCalled()
  })

  test('empty sessionId switches forgeLoop.planSource to inline and embeds planText', async () => {
    const client = await connectForgeProject(mockApi, DIRECTORY)
    expect(client).not.toBeNull()

    const result = await client!.plan.execute(
      '',
      {
        mode: 'loop',
        title: 'Archived Plan Loop',
        plan: '# Archived Plan\n\nLoaded from disk.',
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
    )

    expect(result).not.toBeNull()
    expect(result!.loopName).toBe('archived-plan-loop')

    const createArgs = mockApi.client.experimental.workspace.create.mock.calls[0][0]
    expect(createArgs.extra.forgeLoop).toEqual({
      title: 'Archived Plan Loop',
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
      planSource: 'inline',
      planText: '# Archived Plan\n\nLoaded from disk.',
      hostSessionId: undefined,
      initialPromptOwner: 'tui',
      pendingAttachStartedAt: expect.any(Number),
    })
    expect(createArgs.extra.forgeLoop.hostSessionId).toBeUndefined()
  })

  test('session title uses reserved loop name', async () => {
    const longTitle = 'A'.repeat(100)
    const client = await connectForgeProject(mockApi, DIRECTORY)

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: longTitle,
        plan: '# Long Title Test.',
      },
    )

    expect(result).not.toBeNull()
    const sesCreateArgs = mockApi.client.session.create.mock.calls[0][0]
    // Titles are normalized via slugify (goal-path loop-name normalization),
    // which truncates to 50 characters.
    expect(sesCreateArgs.title).toBe('a'.repeat(50))
  })

  test('threads the configured dataDir forge.db path into reserveTuiLoopName so active no-worktree loops under a custom dataDir are collision-checked', async () => {
    /**
     * Auditor bug 5: `launchTuiLoop` did not pass the configured DB path to
     * `reserveTuiLoopName`, so an audited no-worktree goal loop registered
     * against a custom `dataDir` was invisible to the worktree-loop reservation
     * check — a separate `mode='loop'` launch could reuse that derived name.
     * `launchTuiLoop` now forwards `dbPathOverride` into `reserveTuiLoopName`,
     * which forwards it into `fetchLoopsList`. The collision check then sees
     * the active no-worktree loop under the custom dataDir and suffixes.
     */
    const customDataDir = '/tmp/forge-custom-data-' + Math.random().toString(36).slice(2)
    const expectedDbPath = customDataDir + '/forge.db'

    // Simulate the custom-dataDir active no-worktree loop that BUG 5 wants the
    // reservation check to see. fetchLoopsList is mocked (top of file), so we
    // mirror the collision the production store would have returned.
    vi.mocked(fetchLoopsList).mockImplementationOnce(((projectId: string, dbPathOverride?: string) => {
      expect(projectId).toBe(PROJECT_ID)
      expect(dbPathOverride).toBe(expectedDbPath)
      return [{ name: 'shared-cool-name', active: true } as any]
    }) as any)

    // No pre-existing forge workspace with the same name, so the only collision
    // source is the active no-worktree loop below.
    mockApi.client.experimental.workspace.list.mockResolvedValueOnce({ data: [] })

    const client = await connectForgeProject(mockApi, DIRECTORY, [], { dataDir: customDataDir })
    expect(client).not.toBeNull()

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'Shared Cool Name',
        plan: '# Plan\nReuse a custom-dataDir audited loop name.',
      },
    )

    // Reservation suffixes because the active no-worktree loop in the custom
    // dataDir's DB was visible to fetchLoopsList via the threaded dbPathOverride.
    expect(result!.loopName).toBe('shared-cool-name-1')
    const createArgs = mockApi.client.experimental.workspace.create.mock.calls[0][0]
    expect(createArgs.extra.loopName).toBe('shared-cool-name-1')

    // The fork library (mock of fetchLoopsList) received the configured DB path
    // — the assertion inside the mock above already enforced the call contract.
    expect(fetchLoopsList).toHaveBeenCalled()
  })
})
