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

describe('Load Plans inline plan is sent as inline even when host session exists', () => {
  const PROJECT_ID = 'proj_test'
  const DIRECTORY = '/tmp/test'
  const SESSION_ID = 'ses_existing_host'

  let mockApi: any

  beforeEach(() => {
    process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
    mockApi = {
      client: {
        project: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: PROJECT_ID, worktree: DIRECTORY }],
          }),
        },
        experimental: {
          workspace: {
            create: vi.fn().mockImplementation(async (args: any) => ({
              data: {
                id: 'ws_loop',
                directory: '/tmp/wt/loop',
                branch: null,
              },
            })),
            syncList: vi.fn().mockImplementation(async () => undefined),
            status: vi.fn().mockImplementation(async () => ({
              data: [{ workspaceID: 'ws_loop', status: 'connected' }],
            })),
          },
        },
        session: {
          create: vi.fn().mockImplementation(async (args: any) => ({
            data: { id: 'sess_new' },
          })),
          promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        },
        tui: {
          selectSession: vi.fn().mockImplementation(async () => {}),
        },
      },
      route: {
        navigate: vi.fn().mockImplementation(() => {}),
      },
    }
  })

  test('plan.execute({ mode: "loop" }) always sends inline planText for Load Plans dialog flow, even when a host session is selected', async () => {
    const client = await connectForgeProject(mockApi, DIRECTORY)
    expect(client).not.toBeNull()

    await client!.plan.execute(
      SESSION_ID,
      {
        mode: 'loop',
        title: 'My Plan',
        plan: '# My Plan\n\nFresh content',
        executionModel: undefined,
        auditorModel: undefined,
      },
      {} as any,
    )

    const createArgs = mockApi.client.experimental.workspace.create.mock.calls[0][0]
    const forgeLoop = createArgs.extra.forgeLoop

    expect(forgeLoop.planSource).toBe('inline')
    expect(forgeLoop.planText).toBe('# My Plan\n\nFresh content')
    expect(forgeLoop.hostSessionId).toBe(SESSION_ID)

    expect(mockApi.client.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'sess_new',
      directory: '/tmp/wt/loop',
      workspace: 'ws_loop',
      agent: 'code',
      parts: [{ type: 'text', text: '# My Plan\n\nFresh content' }],
    })
  })
})
