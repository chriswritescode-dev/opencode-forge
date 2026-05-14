import { describe, test, expect, beforeEach, vi } from 'vitest'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

vi.mock('../../src/utils/tui-execution-preferences', () => ({
  readExecutionPreferences: vi.fn().mockReturnValue(null),
  writeExecutionPreferences: vi.fn(),
}))

vi.mock('../../src/utils/tui-plan-store', () => ({
  readPlan: vi.fn().mockReturnValue(null),
  readPlanForAnyProject: vi.fn().mockReturnValue(null),
  writePlan: vi.fn(),
  deletePlan: vi.fn(),
}))

vi.mock('../../src/utils/tui-models', () => ({
  fetchAvailableModels: vi.fn().mockResolvedValue({ providers: [] }),
}))

vi.mock('../../src/utils/workspace-listing', () => ({
  listConnectedWorkspaces: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/storage', () => ({
  resolveLogPath: vi.fn().mockReturnValue('/tmp/forge-test.log'),
}))

vi.mock('../../src/services/execution', () => ({
  ForgeLoopExtra: {},
}))

import { connectForgeProject } from '../../src/utils/tui-client'

describe('TUI warp flow for plan.execute mode=loop', () => {
  const PROJECT_ID = 'proj_test'
  const DIRECTORY = '/tmp/test'
  const SESSION_ID = 'sess_host'

  let callOrder: string[]
  let mockApi: any

  beforeEach(() => {
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
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
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
      'session.create',
      'workspace.status',
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
    expect(createArgs.extra.forgeLoop).toEqual({
      loopName: 'my-cool-feature',
      hostSessionId: SESSION_ID,
      title: 'My Cool Feature',
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
      planSource: 'inline',
      planText: '# Plan\n\nImplement feature X.',
    })

    // Verify session.create was called with correct params
    const sesCreateArgs = mockApi.client.session.create.mock.calls[0][0]
    expect(sesCreateArgs.workspaceID).toBe('ws_loop')
    expect(sesCreateArgs.workspace).toBeUndefined()
    expect(sesCreateArgs.title).toBe('My Cool Feature')
    expect(sesCreateArgs.directory).toBe('/tmp/wt/loop')

    // Verify route.navigate was called instead of tui.selectSession
    expect(mockApi.route.navigate).toHaveBeenCalledWith('session', { sessionID: 'sess_new' })
    expect(mockApi.client.tui.selectSession).not.toHaveBeenCalled()

    // syncList called twice
    expect(mockApi.client.experimental.workspace.syncList).toHaveBeenCalledTimes(2)
  })

  test('failure: workspace.create returns error → returns null, downstream NOT called', async () => {
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
      {} as any,
    )

    expect(result).toBeNull()
    // Downstream calls should not have been made
    expect(mockApi.client.session.create).not.toHaveBeenCalled()
    expect(mockApi.client.tui.selectSession).not.toHaveBeenCalled()
    expect(mockApi.client.experimental.workspace.syncList).not.toHaveBeenCalled()
  })

  test('failure: workspace.create returns no data → returns null', async () => {
    mockApi.client.experimental.workspace.create.mockResolvedValueOnce({ data: undefined })

    const client = await connectForgeProject(mockApi, DIRECTORY)

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'No Data Loop',
        plan: '# No Data\n\nShould fail.',
      },
      {} as any,
    )

    expect(result).toBeNull()
  })

  test('failure: session.create returns error → returns null', async () => {
    mockApi.client.session.create.mockResolvedValueOnce({ error: new Error('session create fail') })

    const client = await connectForgeProject(mockApi, DIRECTORY)

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'Sess Fail Loop',
        plan: '# Session Fail.\n',
      },
      {} as any,
    )

    expect(result).toBeNull()
    // workspace.create should still have been called but downstream after session.create shouldn't
    expect(mockApi.client.experimental.workspace.create).toHaveBeenCalled()
    expect(mockApi.client.tui.selectSession).not.toHaveBeenCalled()
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
      {} as any,
    )

    expect(result).not.toBeNull()
    expect(result!.loopName).toBe('archived-plan-loop')

    const createArgs = mockApi.client.experimental.workspace.create.mock.calls[0][0]
    expect(createArgs.extra.forgeLoop).toEqual({
      loopName: 'archived-plan-loop',
      title: 'Archived Plan Loop',
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
      planSource: 'inline',
      planText: '# Archived Plan\n\nLoaded from disk.',
    })
    expect(createArgs.extra.forgeLoop.hostSessionId).toBeUndefined()
  })

  test('title truncation at 60 chars in session.create', async () => {
    const longTitle = 'A'.repeat(100)
    const client = await connectForgeProject(mockApi, DIRECTORY)

    const result = await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: longTitle,
        plan: '# Long Title Test.',
      },
      {} as any,
    )

    expect(result).not.toBeNull()
    // Title should be truncated to "AAAA...AA..."
    const sesCreateArgs = mockApi.client.session.create.mock.calls[0][0]
    expect(sesCreateArgs.title.length).toBeLessThanOrEqual(60)
    expect(sesCreateArgs.title.endsWith('...')).toBe(true)
  })
})
