import { describe, test, expect, beforeEach, vi } from 'vitest'

// ── Module mocks required by the transitively-imported launchTuiLoop ──────

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

// ── SUT ───────────────────────────────────────────────────────────────────

import { launchTuiLoop } from '../../src/utils/tui-client'
import type { ForgeClient } from '../../src/client/port'
import { createFakeForgeClient } from '../helpers/fake-client'
import { buildAuditSessionPermissionRuleset, buildLoopPermissionRuleset } from '../../src/constants/loop'

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Fake ForgeClient with remote-launch flow defaults: a fixed workspace/
 * session id pair and a `connected` status so the poll resolves immediately.
 */
function makeFakeClient(): ForgeClient {
  const { client } = createFakeForgeClient({
    session: {
      create: async () => ({ id: 'sess_remote' }),
    },
    workspace: {
      create: async () => ({ id: 'ws_remote', directory: '/remote/wt', branch: null }),
      status: async () => [{ workspaceID: 'ws_remote', status: 'connected' }],
    },
  })
  return client
}

beforeEach(() => {
  process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
})

// ── Tests ─────────────────────────────────────────────────────────────────

describe('launchTuiLoop initialPrompt', () => {
  test('with initialPrompt: session uses audit ruleset and promptAsync sends the override text/agent/model/variant', async () => {
    const client = makeFakeClient()

    const result = await launchTuiLoop({
      client,
      directory: '/p',
      projectId: null,
      requestedLoopName: 'moved',
      loopNameReserved: true,
      title: 'Moved',
      plan: '# Plan',
      permissionOptions: {},
      initialPrompt: {
        text: 'AUDIT NOW',
        agent: 'auditor-loop',
        model: { providerID: 'p', modelID: 'm' },
        variant: 'high',
      },
    })

    expect('error' in result).toBe(false)

    const createArgs = (client.session.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createArgs.permission).toEqual(buildAuditSessionPermissionRuleset({}))

    const promptCalls = (client.session.promptAsync as ReturnType<typeof vi.fn>).mock.calls
    expect(promptCalls).toHaveLength(1)
    const promptArgs = promptCalls[0][0]
    expect(promptArgs.agent).toBe('auditor-loop')
    expect(promptArgs.parts[0].type).toBe('text')
    expect(promptArgs.parts[0].text).toBe('AUDIT NOW')
    expect(promptArgs.model).toEqual({ providerID: 'p', modelID: 'm' })
    expect(promptArgs.variant).toBe('high')
  })

  test('without initialPrompt: deterministic section-0 prompt with code agent (existing behavior)', async () => {
    const client = makeFakeClient()

    const plan = [
      '<!-- forge-plan:start -->',
      '# My Plan',
      '<!-- forge-section -->',
      '## First Section',
      'Do first work.',
      '<!-- forge-section -->',
      '## Second Section',
      'Do second work.',
      '<!-- forge-plan:end -->',
    ].join('\n')

    const result = await launchTuiLoop({
      client,
      directory: '/p',
      projectId: null,
      requestedLoopName: 'moved',
      loopNameReserved: true,
      title: 'Moved',
      plan,
      permissionOptions: {},
    })

    expect('error' in result).toBe(false)

    const createArgs = (client.session.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createArgs.permission).toEqual(buildLoopPermissionRuleset({}))

    const promptCalls = (client.session.promptAsync as ReturnType<typeof vi.fn>).mock.calls
    expect(promptCalls).toHaveLength(1)
    const promptArgs = promptCalls[0][0]
    expect(promptArgs.agent).toBe('code')
    expect(promptArgs.parts[0].text).toContain('[Loop section 1/2 -- iteration 1/50]')
    expect(promptArgs.parts[0].text).toContain('## First Section')
    expect(promptArgs.parts[0].text).not.toContain('Second Section')
    expect(promptArgs.model).toBeUndefined()
    expect(promptArgs.variant).toBeUndefined()
  })

  test('without initialPrompt and without a sectioned plan: sends the raw plan as prompt text', async () => {
    const client = makeFakeClient()

    const result = await launchTuiLoop({
      client,
      directory: '/p',
      projectId: null,
      requestedLoopName: 'moved',
      loopNameReserved: true,
      title: 'Moved',
      plan: '# Plain Plan',
      permissionOptions: {},
    })

    expect('error' in result).toBe(false)

    const promptCalls = (client.session.promptAsync as ReturnType<typeof vi.fn>).mock.calls
    expect(promptCalls).toHaveLength(1)
    const promptArgs = promptCalls[0][0]
    expect(promptArgs.agent).toBe('code')
    expect(promptArgs.parts[0].text).toBe('# Plain Plan')
  })

  test('removes the created workspace when session.create throws', async () => {
    const { client } = createFakeForgeClient({
      session: {
        create: async () => {
          throw new Error('session create exploded')
        },
      },
      workspace: {
        create: async () => ({ id: 'ws_orphan', directory: '/remote/wt', branch: null }),
        status: async () => [{ workspaceID: 'ws_orphan', status: 'connected' }],
      },
    })

    const result = await launchTuiLoop({
      client,
      directory: '/p',
      projectId: null,
      requestedLoopName: 'moved',
      loopNameReserved: true,
      title: 'Moved',
      plan: '# Plan',
      permissionOptions: {},
    })

    expect(result).toEqual({ error: 'Loop launch failed: session create exploded' })
    expect(client.workspace.remove).toHaveBeenCalledTimes(1)
    expect(client.workspace.remove).toHaveBeenCalledWith({ id: 'ws_orphan' })
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })
})
