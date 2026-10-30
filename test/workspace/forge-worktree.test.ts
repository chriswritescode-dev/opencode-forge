import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  bindSessionToWorkspace,
  createBuiltinWorktreeWorkspace,
  getForgeWorkspaceBranch,
  getForgeWorkspacePermissionRules,
} from '../../src/workspace/forge-worktree'
import { createFakeForgeClient } from '../helpers/fake-client'
import type { ForgeClient } from '../../src/client/port'
import { resolveLoopPermissionOptionsForWorkspace } from '../../src/utils/loop-permission-options'

function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

describe('createBuiltinWorktreeWorkspace', () => {
  let logger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    logger = createMockLogger()
  })

  describe('createBuiltinWorktreeWorkspace', () => {
    it('creates a workspace and returns its id, directory, and branch', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-1', directory: '/tmp/wt-1', branch: 'feature/x' }),
          list: async () => [{ id: 'ws-1' }],
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'foo', directory: '/tmp/project' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-1', directory: '/tmp/wt-1', branch: 'feature/x' } })
    })

    it('recovers when re-provisioning an existing worktree (regression)', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-recovered', directory: '/tmp/wt-recovered', branch: 'fix/recovery' }),
          list: async () => [{ id: 'ws-recovered' }],
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'recovery-loop', directory: '/tmp/wt-recovered' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-recovered', directory: '/tmp/wt-recovered', branch: 'fix/recovery' } })
    })

    it('creates the workspace without directory scope', async () => {
      const { client, calls } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-scoped', directory: '/tmp/wt-scoped', branch: 'feature/scoped' }),
          list: async () => [],
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'scoped-loop', directory: '/tmp/project' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-scoped', directory: '/tmp/wt-scoped', branch: 'feature/scoped' } })
      const createCalls = calls.filter(c => c.method === 'workspace.create')
      expect(createCalls[0].params).toEqual({
        type: 'forge',
        branch: null,
        extra: {
          loopName: 'scoped-loop',
          projectDirectory: '/tmp/project',
          workspaceCreatedAt: expect.any(Number),
        },
      })
    })

    it('creates workspace without removing old forge workspaces (sweep handles orphan cleanup on teardown)', async () => {
      const { client, calls } = createFakeForgeClient({
        workspace: {
          list: async () => [
            { id: 'ws-old-name', type: 'forge', name: 'sync-loop' },
            { id: 'ws-old-extra', type: 'forge', extra: { loopName: 'sync-loop' } },
          ],
          create: async () => ({ id: 'ws-new', directory: '/tmp/wt-new', branch: 'feature/new' }),
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'sync-loop', directory: '/tmp/project' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-new', directory: '/tmp/wt-new', branch: 'feature/new' } })
      const removeCalls = calls.filter(c => c.method === 'workspace.remove')
      expect(removeCalls.length).toBe(0)
    })

    it('returns no-workspace-id when create returns no id field', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ directory: '/x', branch: 'b' }),
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'no-id', directory: '/tmp/project' },
        logger,
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.reason).toBe('no-workspace-id')
    })

    it('returns empty-directory when create returns empty directory', async () => {
      const { client } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-empty', directory: '', branch: 'b' }),
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'empty-dir', directory: '/tmp/project' },
        logger,
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.reason).toBe('empty-directory')
    })

    it('forwards the explicit branch as extra.branch on the created workspace', async () => {
      const { client, calls } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-branch', directory: '/tmp/wt-branch', branch: 'pm-61-export' }),
          list: async () => [{ id: 'ws-branch' }],
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        { loopName: 'branch-loop', directory: '/tmp/project', branch: 'pm-61-export' },
        logger,
      )

      expect(result).toEqual({ ok: true, workspace: { workspaceId: 'ws-branch', directory: '/tmp/wt-branch', branch: 'pm-61-export' } })
      const createCalls = calls.filter(c => c.method === 'workspace.create')
      expect(createCalls[0].params).toEqual({
        type: 'forge',
        branch: null,
        extra: {
          loopName: 'branch-loop',
          projectDirectory: '/tmp/project',
          workspaceCreatedAt: expect.any(Number),
          branch: 'pm-61-export',
        },
      })
    })

    it('drops a stale extra.branch when no explicit branch is requested', async () => {
      const safeRule = { permission: 'webfetch', pattern: '*', action: 'deny' as const }
      const { client, calls } = createFakeForgeClient({
        workspace: {
          create: async () => ({ id: 'ws-stale', directory: '/tmp/wt-stale', branch: 'forge/stale-loop' }),
          list: async () => [{ id: 'ws-stale' }],
        },
      })

      const result = await createBuiltinWorktreeWorkspace(
        client as unknown as ForgeClient,
        {
          loopName: 'stale-loop',
          directory: '/tmp/project',
          extra: { branch: 'stale-branch', permissionRules: [safeRule] },
        },
        logger,
      )

      expect(result.ok).toBe(true)
      const createCalls = calls.filter(c => c.method === 'workspace.create')
      expect(createCalls[0].params).toEqual({
        type: 'forge',
        branch: null,
        extra: {
          permissionRules: [safeRule],
          loopName: 'stale-loop',
          projectDirectory: '/tmp/project',
          workspaceCreatedAt: expect.any(Number),
        },
      })
    })
  })
})

describe('getForgeWorkspaceBranch', () => {
  it('returns the explicit branch from extra', () => {
    expect(getForgeWorkspaceBranch({ extra: { branch: 'pm-61-export' } })).toBe('pm-61-export')
  })

  it('returns undefined when the branch key is missing', () => {
    expect(getForgeWorkspaceBranch({ extra: { loopName: 'foo' } })).toBeUndefined()
  })

  it('returns undefined when the branch is an empty string', () => {
    expect(getForgeWorkspaceBranch({ extra: { branch: '' } })).toBeUndefined()
  })

  it('returns undefined when the branch is not a string', () => {
    expect(getForgeWorkspaceBranch({ extra: { branch: 42 } })).toBeUndefined()
    expect(getForgeWorkspaceBranch({ extra: { branch: null } })).toBeUndefined()
  })

  it('returns undefined for a non-object extra', () => {
    expect(getForgeWorkspaceBranch({ extra: 'branch' })).toBeUndefined()
    expect(getForgeWorkspaceBranch({ extra: null })).toBeUndefined()
    expect(getForgeWorkspaceBranch({})).toBeUndefined()
  })
})

describe('portable workspace permissions', () => {
  it('accepts only safe deny rules', () => {
    const safeRule = { permission: 'webfetch', pattern: '*', action: 'deny' as const }
    const entry = {
      extra: {
        permissionRules: [
          safeRule,
          { permission: 'external_directory', pattern: '*', action: 'allow' },
          { permission: 'question', pattern: '*', action: 'deny' },
          { permission: 'bash', pattern: '*', action: 'deny' },
        ],
      },
    }

    expect(getForgeWorkspacePermissionRules(entry)).toEqual([safeRule])
  })

  it('retries workspace permission lookup after a transient failure', async () => {
    let attempts = 0
    const safeRule = { permission: 'webfetch', pattern: '*', action: 'deny' as const }
    const { client } = createFakeForgeClient({
      workspace: {
        list: async () => {
          attempts++
          if (attempts === 1) throw new Error('temporarily unavailable')
          return [{ id: 'ws-1', extra: { permissionRules: [safeRule] } }]
        },
      },
    })

    expect(await resolveLoopPermissionOptionsForWorkspace(client, undefined, 'ws-1')).not.toHaveProperty('extraRules.0')
    expect(await resolveLoopPermissionOptionsForWorkspace(client, undefined, 'ws-1')).toMatchObject({ extraRules: [safeRule] })
    expect(attempts).toBe(2)
  })
})

describe('bindSessionToWorkspace', () => {
  it('matches Warp dialog by warping without directory scope', async () => {
    const { client, calls } = createFakeForgeClient({
      workspace: {
        warp: async () => {},
        list: async () => [{ id: 'ws-1' }],
      },
    })

    await bindSessionToWorkspace(client as unknown as ForgeClient, 'ws-1', 'sess-1', createMockLogger())

    const warpCalls = calls.filter(c => c.method === 'workspace.warp')
    expect(warpCalls.length).toBe(1)
    expect(warpCalls[0].params).toEqual({
      id: 'ws-1',
      sessionID: 'sess-1',
    })
  })

  it('checks workspace list after successful warp binding', async () => {
    const { client, calls } = createFakeForgeClient({
      workspace: {
        warp: async () => {},
        list: async () => [{ id: 'ws-1' }],
      },
    })
    const logger = createMockLogger()

    await bindSessionToWorkspace(client as unknown as ForgeClient, 'ws-1', 'sess-1', logger)

    const listCalls = calls.filter(c => c.method === 'workspace.list')
    expect(listCalls.length).toBe(1)
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('listed=true'),
    )
  })
})
