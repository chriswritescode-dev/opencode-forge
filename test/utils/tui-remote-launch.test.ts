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

import { executeRemoteLoop, connectRemoteProject, pushForgeSyncRef, deleteForgeSyncRef } from '../../src/utils/tui-remote-launch'
import type { PluginConfig } from '../../src/types'
import type { GitService, GitResult } from '../../src/utils/git-service'
import type { ForgeClient } from '../../src/client/port'
import type { RemoteClientOptions } from '../../src/client/sdk-adapter'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createFakeGitService } from '../helpers/fake-git'
import {
  makeFakeRemoteClient as makeFakeClient,
  createClientSpy,
  REMOTE_URL,
  LOCAL_PROJECT_ID,
} from '../helpers/fake-remote-client'

// ── Helpers ───────────────────────────────────────────────────────────────

const defaultOk: GitResult = { ok: true, status: 0, stdout: '', stderr: '' }

// ── Shared test values ────────────────────────────────────────────────────

const LOCAL_DIR = '/home/user/my-project'

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

/** True when the resolved client is the spy's second (scoped) client. */
function clientsMatch(client: ForgeClient, spy: ReturnType<typeof vi.fn>): boolean {
  const scoped = spy.mock.calls[1]?.[0]
  return scoped !== undefined && spy.mock.results[1]?.value === client
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

  test('forwards sandboxEnabled=false from remote config to the forgeLoop envelope', async () => {
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
  })

  // ── loop.permissions config threaded to remote session.create ───────────

  test('surfaces dropped loop.permissions warnings on the remote-launch surface', async () => {
    const config: PluginConfig = {
      remotes: [
        { name: 'server1', url: REMOTE_URL, password: 'sekret' },
      ],
      loop: {
        permissions: { deny: ['*'] },
      },
    }
    const git = happyGit()
    const { spy: createClient } = createClientSpy()
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

    expect('error' in result).toBe(false)

    // The dropped Forge-managed deny rule is surfaced to the user, not dropped silently.
    expect(onWarning).toHaveBeenCalledTimes(1)
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('loop.permissions.deny entry "*" is ignored'),
    )
  })

  test('threads loop.permissions deny rules to remote session.create but omits host external_directory allow rules', async () => {
    const config: PluginConfig = {
      remotes: [
        { name: 'server1', url: REMOTE_URL, password: 'sekret' },
      ],
      loop: {
        allowExternalDirectories: ['/home/user/Obsidian'],
        permissions: {
          deny: [{ permission: 'webfetch', pattern: '*' }],
        },
      },
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
    const createArgs = (remoteClient.session.create as ReturnType<typeof vi.fn>).mock.calls[0][0]

    // Configured deny rule reaches the remote permission array
    expect(createArgs.permission).toEqual(
      expect.arrayContaining([
        { permission: 'webfetch', pattern: '*', action: 'deny' },
      ]),
    )

    // No host-specific external_directory allow rule is sent (paths don't exist remotely)
    const externalAllows = createArgs.permission.filter(
      (r: { permission: string; action: string }) =>
        r.permission === 'external_directory' && r.action === 'allow',
    )
    expect(externalAllows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pattern: '/home/user/Obsidian' }),
      ]),
    )

    // Portable rules are persisted in workspace metadata so every subsequent
    // remote session (rotations, audits, post-actions) rebuilds with them.
    const createParams = (remoteClient.workspace.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createParams.extra.permissionRules).toEqual([
      { permission: 'webfetch', pattern: '*', action: 'deny' },
    ])
  })
})

describe('connectRemoteProject', () => {
  test('resolves remote, discovers project by id, and creates a scoped client', async () => {
    const config = happyConfig()
    const { spy: createClient } = createClientSpy()
    const debug = vi.fn()

    const result = await connectRemoteProject(
      { remoteName: 'server1', localProjectId: LOCAL_PROJECT_ID },
      { config, createClient: createClient as any, debug },
    )

    expect(result).toEqual({
      remote: {
        name: 'server1',
        url: REMOTE_URL,
        password: 'sekret',
        username: 'opencode',
        gitRemote: 'origin',
        sandbox: true,
      },
      project: { id: 'proj_1', worktree: '/remote/my-project' },
      client: expect.anything(),
    })
    const client = (result as { client: ForgeClient }).client
    expect(clientsMatch(client, createClient)).toBe(true)

    // Discovery first (no directory), then scoped with the matched worktree
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
  })

  test('returns error naming configured remotes for an unknown remote name', async () => {
    const config = happyConfig()
    const createClient = vi.fn()

    const result = await connectRemoteProject(
      { remoteName: 'unknown', localProjectId: LOCAL_PROJECT_ID },
      { config, createClient: createClient as any },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('unknown')
      expect(result.error).toContain('server1')
    }
    expect(createClient).not.toHaveBeenCalled()
  })

  test('returns error when project.list fails', async () => {
    const config = happyConfig()
    const clients: ForgeClient[] = []
    const createClient = vi.fn((_opts: RemoteClientOptions) => {
      const client = makeFakeClient()
      client.project.list = vi.fn().mockRejectedValue(new Error('boom')) as any
      clients.push(client)
      return client
    })

    const result = await connectRemoteProject(
      { remoteName: 'server1', localProjectId: LOCAL_PROJECT_ID },
      { config, createClient: createClient as any },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Failed to list projects on remote "server1"')
      expect(result.error).toContain('boom')
    }
  })

  test('returns error when no remote project matches the local project id', async () => {
    const config = happyConfig()
    const clients: ForgeClient[] = []
    const createClient = vi.fn((_opts: RemoteClientOptions) => {
      const client = makeFakeClient()
      client.project.list = vi.fn().mockResolvedValue([
        { id: 'proj_other', worktree: '/remote/other-project' },
      ]) as any
      clients.push(client)
      return client
    })

    const result = await connectRemoteProject(
      { remoteName: 'server1', localProjectId: LOCAL_PROJECT_ID },
      { config, createClient: createClient as any },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain(LOCAL_PROJECT_ID)
      expect(result.error).toContain('proj_other')
    }
  })

  test('returns error when the local project id is missing', async () => {
    const config = happyConfig()
    const { spy: createClient } = createClientSpy()

    const result = await connectRemoteProject(
      { remoteName: 'server1', localProjectId: '' },
      { config, createClient: createClient as any },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('project id')
    }
    expect(createClient).not.toHaveBeenCalled()
  })

  test('calls beforeDiscovery after resolving the remote but before any client creation', async () => {
    const config = happyConfig()
    const createClient = vi.fn()
    const order: string[] = []

    const result = await connectRemoteProject(
      { remoteName: 'server1', localProjectId: LOCAL_PROJECT_ID },
      {
        config,
        createClient: createClient as any,
        beforeDiscovery: () => {
          order.push('beforeDiscovery')
          return { error: 'preflight failed' }
        },
      },
    )

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('preflight failed')
    }
    expect(order).toEqual(['beforeDiscovery'])
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('pushForgeSyncRef / deleteForgeSyncRef', () => {
  test('pushForgeSyncRef pushes sourceRef to syncRef with force and returns ok', () => {
    const git = happyGit()

    const result = pushForgeSyncRef(git, {
      cwd: LOCAL_DIR,
      gitRemote: 'origin',
      sourceRef: 'refs/heads/forge/moved',
      syncRef: 'refs/forge/moved',
    })

    expect(result).toEqual({ ok: true })
    expect(git.push).toHaveBeenCalledTimes(1)
    expect(git.push).toHaveBeenCalledWith(LOCAL_DIR, 'origin', 'refs/heads/forge/moved:refs/forge/moved', true)
  })

  test('pushForgeSyncRef returns ok:false with stderr on push failure', () => {
    const git = happyGit()
    git.push = vi.fn(() => ({
      ok: false,
      status: 1,
      stdout: '',
      stderr: 'error: failed to push some refs',
    })) as any

    const result = pushForgeSyncRef(git, {
      cwd: LOCAL_DIR,
      gitRemote: 'origin',
      sourceRef: 'refs/heads/forge/moved',
      syncRef: 'refs/forge/moved',
    })

    expect(result).toEqual({
      ok: false,
      error: 'error: failed to push some refs',
    })
  })

  test('deleteForgeSyncRef issues a non-forced remote ref deletion', () => {
    const git = happyGit()

    deleteForgeSyncRef(git, { cwd: LOCAL_DIR, gitRemote: 'origin', syncRef: 'refs/forge/moved' })

    expect(git.push).toHaveBeenCalledTimes(1)
    expect(git.push).toHaveBeenCalledWith(LOCAL_DIR, 'origin', ':refs/forge/moved', false)
  })
})
