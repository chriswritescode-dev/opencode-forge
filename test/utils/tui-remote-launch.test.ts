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

import { executeRemoteLoop } from '../../src/utils/tui-remote-launch'
import type { PluginConfig } from '../../src/types'
import type { GitService, GitResult } from '../../src/utils/git-service'
import type { ForgeClient } from '../../src/client/port'
import type { RemoteClientOptions } from '../../src/client/sdk-adapter'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createFakeGitService } from '../helpers/fake-git'

// ── Helpers ───────────────────────────────────────────────────────────────

const defaultOk: GitResult = { ok: true, status: 0, stdout: '', stderr: '' }

/**
 * Fake ForgeClient (shared helper) with remote-loop flow defaults: a fixed
 * workspace/session id pair and a `connected` status so the poll resolves
 * immediately.
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
    project: {
      list: async () => [{ id: 'proj_1', worktree: '/remote/my-project' }],
    },
  })
  return client
}

/** Create a `vi.fn()` based `createClient` factory that records produced clients. */
function createClientSpy(): {
  spy: ReturnType<typeof vi.fn>
  clients: ForgeClient[]
} {
  const clients: ForgeClient[] = []
  const spy = vi.fn((_opts: RemoteClientOptions) => {
    const client = makeFakeClient()
    clients.push(client)
    return client
  })
  return { spy, clients }
}

// ── Shared test values ────────────────────────────────────────────────────

const LOCAL_DIR = '/home/user/my-project'
const REMOTE_URL = 'http://remote:4096'
const LOCAL_PROJECT_ID = 'proj_1'

function happyConfig(): PluginConfig {
  return {
    remotes: [
      { name: 'server1', url: REMOTE_URL, password: 'sekret' },
    ],
  }
}

function happyGit(): GitService {
  return createFakeGitService({
    revParseHead: vi.fn(() => ({ ...defaultOk, stdout: 'abc123def456abc123def456abc123def456abc1\n' })),
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.FORGE_TUI_WORKSPACE_SETTLE_MS = '0'
})

describe('executeRemoteLoop', () => {
  // ── Happy path ──────────────────────────────────────────────────────────

  test('happy path: clean local repo pushes and launches remote loop', async () => {
    const config = happyConfig()
    const git = happyGit()
    const { spy: createClient, clients } = createClientSpy()
    const onWarning = vi.fn()
    const debug = vi.fn()

    const result = await executeRemoteLoop(
      {
        remoteName: 'server1',
        localDirectory: LOCAL_DIR,
        localProjectId: LOCAL_PROJECT_ID,
        title: 'Test Plan',
        loopName: 'test-loop',
        plan: '# Test Plan\n\nDo work.',
      },
      { config, git, createClient: createClient as any, onWarning, debug },
    )

    // Result shape
    expect(result).toEqual({
      loopName: 'test-loop',
      sessionId: 'sess_remote',
      remoteName: 'server1',
    })

    // createClient called twice: discovery (no directory), then scoped
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(createClient).toHaveBeenNthCalledWith(1, {
      url: REMOTE_URL,
      username: 'opencode',
      password: 'sekret',
    })
    expect(createClient).toHaveBeenNthCalledWith(2, {
      url: REMOTE_URL,
      username: 'opencode',
      password: 'sekret',
      directory: '/remote/my-project',
    })

    // git.push called once with the reserved loop name
    expect(git.push).toHaveBeenCalledTimes(1)
    expect(git.push).toHaveBeenCalledWith(LOCAL_DIR, 'origin', 'HEAD:refs/forge/test-loop', true)

    // git.isInsideWorkTree and revParseHead were called as preflight
    expect(git.isInsideWorkTree).toHaveBeenCalledWith(LOCAL_DIR)
    expect(git.revParseHead).toHaveBeenCalledWith(LOCAL_DIR)

    // statusPorcelain was called (clean)
    expect(git.statusPorcelain).toHaveBeenCalledWith(LOCAL_DIR)

    // No warning because working tree is clean
    expect(onWarning).not.toHaveBeenCalled()

    // The second (scoped) client performed the launch: workspace.create was called
    const remoteClient = clients[1]
    expect(remoteClient.workspace.create).toHaveBeenCalledTimes(1)
    const createParams = (remoteClient.workspace.create as ReturnType<typeof vi.fn>).mock.calls[0][0]

    // extraWorkspaceFields merged into extra
    expect(createParams.extra.startRef).toBe('abc123def456abc123def456abc123def456abc1')
    expect(createParams.extra.syncRef).toBe('refs/forge/test-loop')
    expect(createParams.extra.gitRemote).toBe('origin')

    // forgeLoop envelope
    expect(createParams.extra.forgeLoop).toBeDefined()
    expect(createParams.extra.forgeLoop.planSource).toBe('inline')
    expect(createParams.extra.forgeLoop.planText).toBe('# Test Plan\n\nDo work.')
    expect(createParams.extra.forgeLoop.initialPromptOwner).toBe('tui')
    expect(createParams.extra.forgeLoop.sandboxEnabled).toBe(true)

    // session.create was called
    expect(remoteClient.session.create).toHaveBeenCalledTimes(1)
    // promptAsync was called
    expect(remoteClient.session.promptAsync).toHaveBeenCalledTimes(1)
  })

  // ── Error: unknown remote name ──────────────────────────────────────────

  test('returns error for unknown remote name', async () => {
    const config: PluginConfig = {
      remotes: [{ name: 'server1', url: REMOTE_URL }],
    }
    const git = happyGit()
    const createClient = vi.fn()

    const result = await executeRemoteLoop(
      {
        remoteName: 'unknown',
        localDirectory: LOCAL_DIR,
        localProjectId: LOCAL_PROJECT_ID,
        title: 'Test',
        loopName: 'loop',
        plan: 'plan',
      },
      { config, git, createClient: createClient as any },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('unknown')
      expect(result.error).toContain('server1')
    }

    // No git calls should have been made
    expect(createClient).not.toHaveBeenCalled()
    expect(git.isInsideWorkTree).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
  })

  // ── Error: not a git worktree ───────────────────────────────────────────

  test('returns error when local directory is not a git worktree', async () => {
    const config = happyConfig()
    const git = happyGit()
    git.isInsideWorkTree = vi.fn(() => false) as any
    const createClient = vi.fn()

    const result = await executeRemoteLoop(
      {
        remoteName: 'server1',
        localDirectory: LOCAL_DIR,
        localProjectId: LOCAL_PROJECT_ID,
        title: 'Test',
        loopName: 'loop',
        plan: 'plan',
      },
      { config, git, createClient: createClient as any },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Not a git repository')
    }

    // No further git calls after the failed preflight, and no push
    expect(git.revParseHead).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
  })

  // ── Error: revParseHead failure ─────────────────────────────────────────

  test('returns error when revParseHead fails', async () => {
    const config = happyConfig()
    const git = happyGit()
    git.revParseHead = vi.fn(() => ({
      ok: false,
      status: 128,
      stdout: '',
      stderr: 'fatal: Not a git repository (or any of the parent directories)',
    })) as any
    const createClient = vi.fn()

    const result = await executeRemoteLoop(
      {
        remoteName: 'server1',
        localDirectory: LOCAL_DIR,
        localProjectId: LOCAL_PROJECT_ID,
        title: 'Test',
        loopName: 'loop',
        plan: 'plan',
      },
      { config, git, createClient: createClient as any },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Failed to resolve HEAD')
      expect(result.error).toContain('fatal: Not a git repository')
    }

    // No push, no client creation
    expect(git.push).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
  })

  // ── Error: push failure ─────────────────────────────────────────────────

  test('returns error when git push fails', async () => {
    const config = happyConfig()
    const git = happyGit()
    git.push = vi.fn(() => ({
      ok: false,
      status: 1,
      stdout: '',
      stderr: 'error: failed to push some refs',
    })) as any
    const { spy: createClient, clients } = createClientSpy()

    const result = await executeRemoteLoop(
      {
        remoteName: 'server1',
        localDirectory: LOCAL_DIR,
        localProjectId: LOCAL_PROJECT_ID,
        title: 'Test',
        loopName: 'loop',
        plan: 'plan',
      },
      { config, git, createClient: createClient as any },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Failed to push')
      expect(result.error).toContain('error: failed to push some refs')
    }

    // createClient WAS called (discovery + scoped), but workspace.create was NOT called
    // because push failure stops before launchTuiLoop
    expect(git.push).toHaveBeenCalledTimes(1)
    expect(clients.length).toBeGreaterThanOrEqual(1)

    // The scoped client (last one) should NOT have workspace.create called
    const scopedClient = clients[clients.length - 1]
    expect(scopedClient.workspace.create).not.toHaveBeenCalled()
    expect(scopedClient.session.create).not.toHaveBeenCalled()
  })

  // ── Error: no matching remote project ───────────────────────────────────

  test('returns error when no remote project matches the local OpenCode project id', async () => {
    const config = happyConfig()
    const git = happyGit()

    // Provide a custom client factory that returns non-matching projects
    const clients: ForgeClient[] = []
    const createClient = vi.fn((_opts: RemoteClientOptions) => {
      const client = makeFakeClient()
      client.project.list = vi.fn().mockResolvedValue([
        { id: 'proj_other', worktree: '/remote/other-project' },
      ]) as any
      clients.push(client)
      return client
    })

    const result = await executeRemoteLoop(
      {
        remoteName: 'server1',
        localDirectory: LOCAL_DIR,
        localProjectId: LOCAL_PROJECT_ID,
        title: 'Test',
        loopName: 'loop',
        plan: 'plan',
      },
      { config, git, createClient: createClient as any },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain(LOCAL_PROJECT_ID)
      expect(result.error).toContain('proj_other')
    }

    // No push after failed match
    expect(git.push).not.toHaveBeenCalled()
  })

  // ── Error: local project id could not be resolved ───────────────────────

  test('returns error when the local project id is missing', async () => {
    const config = happyConfig()
    const git = happyGit()
    const { spy: createClient } = createClientSpy()

    const result = await executeRemoteLoop(
      {
        remoteName: 'server1',
        localDirectory: LOCAL_DIR,
        localProjectId: '',
        title: 'Test',
        loopName: 'loop',
        plan: 'plan',
      },
      { config, git, createClient: createClient as any },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('project id')
    }

    // No discovery client, no push when identity is unknown
    expect(createClient).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
  })

  // ── Matches by project id, not worktree path ────────────────────────────

  test('matches by project id even when worktree basenames collide', async () => {
    const config = happyConfig()
    const git = happyGit()

    const clients: ForgeClient[] = []
    const createClient = vi.fn((_opts: RemoteClientOptions) => {
      const client = makeFakeClient()
      // Two projects with the same worktree basename; only the id disambiguates.
      client.project.list = vi.fn().mockResolvedValue([
        { id: 'proj_other', worktree: '/remote-a/my-project' },
        { id: LOCAL_PROJECT_ID, worktree: '/remote-b/my-project' },
      ]) as any
      clients.push(client)
      return client
    })

    const result = await executeRemoteLoop(
      {
        remoteName: 'server1',
        localDirectory: LOCAL_DIR,
        localProjectId: LOCAL_PROJECT_ID,
        title: 'Test',
        loopName: 'loop',
        plan: 'plan',
      },
      { config, git, createClient: createClient as any },
    )

    expect('error' in result).toBe(false)

    // The scoped client was created for the id-matched project's worktree,
    // not the first basename collision.
    expect(createClient).toHaveBeenNthCalledWith(2, {
      url: REMOTE_URL,
      username: 'opencode',
      password: 'sekret',
      directory: '/remote-b/my-project',
    })
    expect(git.push).toHaveBeenCalledTimes(1)
  })

  // ── Dirty working tree (warning) ────────────────────────────────────────

  test('calls onWarning when working tree is dirty but still proceeds', async () => {
    const config = happyConfig()
    const git = happyGit()
    git.statusPorcelain = vi.fn(() => ({
      ...defaultOk,
      stdout: ' M modified-file.txt\n',
    })) as any
    const { spy: createClient, clients } = createClientSpy()
    const onWarning = vi.fn()

    const result = await executeRemoteLoop(
      {
        remoteName: 'server1',
        localDirectory: LOCAL_DIR,
        localProjectId: LOCAL_PROJECT_ID,
        title: 'Test Plan',
        loopName: 'test-loop',
        plan: '# Test Plan\n\nDo work.',
      },
      { config, git, createClient: createClient as any, onWarning },
    )

    // Result still succeeds
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.loopName).toBe('test-loop')
      expect(result.sessionId).toBe('sess_remote')
      expect(result.remoteName).toBe('server1')
    }

    // onWarning was called with the right message
    expect(onWarning).toHaveBeenCalledTimes(1)
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('Uncommitted changes are not included'),
    )
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('abc1'),
    )

    // Push still happened
    expect(git.push).toHaveBeenCalledTimes(1)
    // Launch still happened
    const remoteClient = clients[1]
    expect(remoteClient.workspace.create).toHaveBeenCalledTimes(1)
    expect(remoteClient.session.promptAsync).toHaveBeenCalledTimes(1)
  })

  // ── sandbox=false remote ────────────────────────────────────────────────

  test('forwards sandboxEnabled=false from remote config to forgeLoop and permission', async () => {
    const config: PluginConfig = {
      remotes: [
        { name: 'server1', url: REMOTE_URL, password: 'sekret', sandbox: false },
      ],
    }
    const git = happyGit()
    const { spy: createClient, clients } = createClientSpy()

    const result = await executeRemoteLoop(
      {
        remoteName: 'server1',
        localDirectory: LOCAL_DIR,
        localProjectId: LOCAL_PROJECT_ID,
        title: 'Test Plan',
        loopName: 'test-loop',
        plan: '# Test Plan\n\nDo work.',
      },
      { config, git, createClient: createClient as any },
    )

    expect('error' in result).toBe(false)

    const remoteClient = clients[1]
    const createParams = (remoteClient.workspace.create as ReturnType<typeof vi.fn>).mock.calls[0][0]

    // forgeLoop envelope carries sandboxEnabled: false from forgeLoopOverrides
    expect(createParams.extra.forgeLoop).toBeDefined()
    expect(createParams.extra.forgeLoop.sandboxEnabled).toBe(false)

    // session create permission should reflect sandbox=false (bash allowed, sh denied)
    const sessionCreateParams = (remoteClient.session.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sessionCreateParams.permission).toBeDefined()
    const bashRule = sessionCreateParams.permission.find(
      (r: { permission: string }) => r.permission === 'bash',
    )
    const shRule = sessionCreateParams.permission.find(
      (r: { permission: string }) => r.permission === 'sh',
    )
    expect(bashRule?.action).toBe('allow')
    expect(shRule?.action).toBe('deny')
  })
})
