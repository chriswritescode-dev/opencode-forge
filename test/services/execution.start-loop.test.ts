import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateUniqueName } from '../../src/loop/name-uniqueness'
import { createForgeExecutionService } from '../../src/services/execution'
import type { Logger } from '../../src/types'
import { buildLoopPermissionRuleset, resolveLoopPermissionOptions, MAX_TOTAL_SECTIONS } from '../../src/constants/loop'
import { createLoopService, type LoopService } from '../../src/loop/service'
import { createLoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import { createTestDb } from '../helpers/test-db'
import { createFakeForgeClient } from '../helpers/fake-client'
import { buildExecutionDeps } from '../helpers/loop-fixtures'
import { createMockLogger } from '../helpers/logger'

const mockLogger = createMockLogger()

const MOCK_BASE_COMMIT = 'a'.repeat(40)

const mockGitService = {
  revParseHead: () => ({ ok: true, status: 0, stdout: `${MOCK_BASE_COMMIT}\n`, stderr: '' }),
  revParse: () => ({ ok: true, status: 0, stdout: `${MOCK_BASE_COMMIT}\n`, stderr: '' }),
  branchExists: () => false,
  checkRefFormatBranch: (_cwd: string, name: string) => ({ ok: true, status: 0, stdout: `${name}\n`, stderr: '' }),
  worktreeList: () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
  isAncestor: () => true,
} as any

function uniqueLoopNameFor(
  service: LoopService,
  baseName: string,
  isTaken?: (name: string) => boolean,
): string {
  const existing = [...service.listActive(), ...service.listRecent()].map((s) => s.loopName)
  return generateUniqueName(baseName, existing, isTaken)
}

const PROJECT_ID = 'test-project'

const openDbs: ReturnType<typeof createTestDb>[] = []

afterEach(() => {
  for (const testDb of openDbs.splice(0)) testDb.cleanup()
})

describe('handleStartLoop builtin worktree workspace', () => {
  let db: ReturnType<typeof createTestDb>['db']

  beforeEach(() => {
    const testDb = createTestDb()
    openDbs.push(testDb)
    db = testDb.db
  })

  test('creates builtin worktree workspace and session bound to it for mode=worktree', async () => {
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test',
          directory: '/tmp/wt/abc',
          branch: 'opencode/abc',
          type: 'worktree',
          name: 'opencode/abc',
          extra: null,
          projectID: PROJECT_ID,
          timeUsed: Date.now(),
        }),
        warp: async () => {},
      },
      session: {
        create: async () => ({ id: 'session_test' }),
        get: async () => ({}),
      },
    })

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockResolvedValue({ containerName: 'opencode-forge-sandbox-test' }),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

    const { deps, loopService } = buildExecutionDeps(db, {
      client,
      gitService: mockGitService,
      sandboxManager: mockSandboxManager as any,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nThis is a test plan.' },
      },
    )

    expect(result.ok).toBe(true)

    // Assert: workspace.create was called (builtin worktree path)
    expect(client.workspace.create).toHaveBeenCalledTimes(1)
    expect(client.workspace.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'forge',
        branch: null,
        extra: expect.objectContaining({
          loopName: 'test-plan',
          projectDirectory: expect.any(String),
          workspaceCreatedAt: expect.any(Number),
        }),
      }),
    )

    // Assert: session was created with correct directory and workspaceId
    expect(client.session.create).toHaveBeenCalledTimes(1)
    const sessionCallArgs = (client.session.create as any).mock.calls[0][0]
    expect(sessionCallArgs.directory).toBe('/tmp/wt/abc')
    expect(sessionCallArgs.workspaceID).toBe('ws_test')

    // Assert: warp was called
    expect(client.workspace.warp).toHaveBeenCalledTimes(1)

    // Assert: loops state has workspace info
    if (!result.ok) return
    const state = loopService.getActiveState(result.data.loopName)
    expect(state).not.toBeNull()
    expect(state!.workspaceId).toBe('ws_test')
    expect(state!.worktreeDir).toBe('/tmp/wt/abc')
    expect(state!.worktreeBranch).toBe('opencode/abc')

    // Assert: plan persisted through plans table (loop-scoped)
    const loopPlanRow = deps.plansRepo.getForLoop(PROJECT_ID, result.data.loopName)
    expect(loopPlanRow).not.toBeNull()
    expect(loopPlanRow!.content).toBe('# Test Plan\n\nThis is a test plan.')

    // Assert: loop_large_fields has no prompt column (removed in migration 127)
    const largeFields = deps.loopsRepo.getLarge(PROJECT_ID, result.data.loopName)
    expect(largeFields).not.toBeNull()
    expect(largeFields).not.toHaveProperty('prompt')
  })

  test('worktree loop succeeds without sandbox manager (worktree-only mode)', async () => {
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test',
          directory: '/tmp/wt/abc',
          branch: 'opencode/abc',
          type: 'worktree',
          name: 'opencode/abc',
          extra: null,
          projectID: PROJECT_ID,
          timeUsed: Date.now(),
        }),
      },
    })

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const { deps, loopService } = buildExecutionDeps(db, {
      client,
      gitService: mockGitService,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nThis is a test plan.' },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Verify loop state shows sandbox=false for worktree-only mode
    const state = loopService.getActiveState(result.data.loopName)
    expect(state).not.toBeNull()
    expect(state!.sandbox).toBe(false)
    expect(state!.worktree).toBe(true)
    expect(state!.sandboxContainer).toBeUndefined()
  })

  test('passes buildLoopPermissionRuleset() to session.create regardless of surface', async () => {
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test',
          directory: '/tmp/wt/abc',
          branch: 'opencode/abc',
          type: 'worktree',
          name: 'opencode/abc',
          extra: null,
          projectID: PROJECT_ID,
          timeUsed: Date.now(),
        }),
      },
      session: {
        create: async () => ({ id: 'sess-1' }),
      },
    })

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockResolvedValue({ containerName: 'opencode-forge-sandbox-test' }),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const { deps, loopService } = buildExecutionDeps(db, {
      client,
      gitService: mockGitService,
      sandboxManager: mockSandboxManager as any,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    for (const surface of ['tool', 'approval-hook'] as const) {
      (client.session.create as any).mockClear()
      await service.dispatch(
        { surface, projectId: PROJECT_ID, directory: '/tmp/test' },
        {
          type: 'loop.start' as const,
          source: { kind: 'inline', planText: '# Test Plan\n\nTest.' },
        },
      )
      expect(client.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          permission: buildLoopPermissionRuleset(resolveLoopPermissionOptions(undefined)),
        }),
      )
    }
  })

  test('passes configured loop.permissions deny rules to session.create', async () => {
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test',
          directory: '/tmp/wt/abc',
          branch: 'opencode/abc',
          type: 'worktree',
          name: 'opencode/abc',
          extra: null,
          projectID: PROJECT_ID,
          timeUsed: Date.now(),
        }),
      },
      session: {
        create: async () => ({ id: 'sess-1' }),
      },
    })

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockResolvedValue({ containerName: 'opencode-forge-sandbox-test' }),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

    const configuredConfig = {
      loop: { enabled: true, permissions: { deny: ['webfetch'] } },
      executionModel: 'prov/exec',
      auditorModel: 'prov/aud',
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const { deps, loopService } = buildExecutionDeps(db, {
      client,
      config: configuredConfig,
      gitService: mockGitService,
      sandboxManager: mockSandboxManager as any,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    await service.dispatch(
      { surface: 'tool', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nTest.' },
      },
    )

    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: buildLoopPermissionRuleset(resolveLoopPermissionOptions(configuredConfig as any)),
      }),
    )
    const createArgs = (client.session.create as any).mock.calls[0][0]
    expect(createArgs.permission).toContainEqual({ permission: 'webfetch', pattern: '*', action: 'deny' })
  })

  test('fails and rolls back when sandbox start throws, propagating the msb detail', async () => {
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test',
          directory: '/tmp/wt/abc',
          branch: 'opencode/abc',
          type: 'worktree',
          name: 'opencode/abc',
          extra: null,
          projectID: PROJECT_ID,
          timeUsed: Date.now(),
        }),
      },
    })

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockRejectedValue(new Error('Sandbox template check failed: msb images: catalog ancestor /home/u/.microsandbox permits path substitution')),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const { deps, loopService } = buildExecutionDeps(db, {
      client,
      gitService: mockGitService,
      sandboxManager: mockSandboxManager as any,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nThis is a test plan.' },
      },
    )

    // Sandbox start failure should return an error, not silently fall back
    expect(result.ok).toBe(false)
    expect(result).toHaveProperty('error')
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error')
      expect(result.error.message).toContain('catalog ancestor')
      expect(result.error.message).toContain('Failed to start sandbox')
    }

    // Verify rollback was invoked (session aborted, workspace removed)
    expect(client.session.abort).toHaveBeenCalled()
    expect(client.workspace.remove).toHaveBeenCalled()

    // Verify sandbox stop was called during rollback
    expect(mockSandboxManager.stop).toHaveBeenCalled()
  })

  test('returns actionable error when workspace.create throws due to missing flag', async () => {
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => { throw new Error('experimental workspaces not enabled') },
      },
    })

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const { deps, loopService } = buildExecutionDeps(db, {
      client,
      gitService: mockGitService,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nMissing flag test.' },
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error')
      expect(result.error.message).toBe((await import('../../src/workspace/workspace-create-error')).EXPERIMENTAL_WORKSPACES_HINT)
      expect(result.error.details?.reason).toBe('experimental-workspaces-disabled')
    }
  })
})

describe('handleStartLoop concurrent-start dedupe', () => {
  function buildDedupeMocks() {
    let sessionCounter = 0
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test',
          directory: '/tmp/wt/abc',
          branch: 'opencode/abc',
          type: 'worktree',
          name: 'opencode/abc',
          extra: null,
          projectID: PROJECT_ID,
          timeUsed: Date.now(),
        }),
        warp: async () => {},
      },
      session: {
        create: async () => ({ id: `session_test_${++sessionCounter}` }),
        get: async () => ({}),
      },
    })

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockResolvedValue({ containerName: 'opencode-forge-sandbox-test' }),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

    return {
      client,
      mockSandboxManager,
    }
  }

  test('two concurrent calls with same source produce only one workspace + session', async () => {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const db = testDb.db
    const mocks = buildDedupeMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const { deps, loopService } = buildExecutionDeps(db, {
      client: mocks.client,
      gitService: mockGitService,
      sandboxManager: mocks.mockSandboxManager as any,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const command = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Dedupe Plan\n\nTest plan for dedupe.' },
      
      hostSessionId: 'host-1',
    }

    const [r1, r2] = await Promise.all([
      service.dispatch(ctx, command),
      service.dispatch(ctx, command),
    ])

    // With dedupe implemented: exactly 1 workspace/session/warp creation per concurrent batch
    expect(mocks.client.workspace.create).toHaveBeenCalledTimes(1)
    expect(mocks.client.session.create).toHaveBeenCalledTimes(1)
    expect(mocks.client.workspace.warp).toHaveBeenCalledTimes(1)

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    if (!r1.ok || !r2.ok) return

    // At least one result should be flagged as deduped; both share the same sessionId/loopName
    const dedupedResults = [r1, r2].filter(r => (r.data as any).deduped === true)
    const realResult = [r1, r2].find(r => !(r.data as any).deduped)
    expect(dedupedResults.length).toBe(1)
    expect(realResult).toBeDefined()
  })

  test('different source sessions do not dedupe each other', async () => {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const db = testDb.db
    const mocks = buildDedupeMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const { deps, loopService } = buildExecutionDeps(db, {
      client: mocks.client,
      gitService: mockGitService,
      sandboxManager: mocks.mockSandboxManager as any,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const cmd1 = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Plan Alpha\n\nDifferent plan A.' },
      
      hostSessionId: 'host-A',
    }
    const cmd2 = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Plan Beta\n\nDifferent plan B.' },
      
      hostSessionId: 'host-B',
    }

    const [r1, r2] = await Promise.all([
      service.dispatch(ctx, cmd1),
      service.dispatch(ctx, cmd2),
    ])

    // Different sources: no dedupe; both proceed independently
    expect(mocks.client.workspace.create).toHaveBeenCalledTimes(2)
    expect(mocks.client.session.create).toHaveBeenCalledTimes(2)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    if (!r1.ok || !r2.ok) return
    expect(r1.data.loopName).not.toBe(r2.data.loopName)
  })

  test('sequential second call after first completes is not deduped', async () => {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const db = testDb.db
    const mocks = buildDedupeMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const { deps, loopService } = buildExecutionDeps(db, {
      client: mocks.client,
      gitService: mockGitService,
      sandboxManager: mocks.mockSandboxManager as any,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const cmd = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Sequential Plan\n\nSequential test.' },
      
      hostSessionId: 'host-seq',
    }

    await service.dispatch(ctx, cmd)
    const second = await service.dispatch(ctx, cmd)

    // Sequential: first completed, in-flight entry cleared, so no dedupe
    expect(mocks.client.workspace.create).toHaveBeenCalledTimes(2)
    expect(mocks.client.session.create).toHaveBeenCalledTimes(2)
    expect(second.ok).toBe(true)
  })
})

describe('handleStartLoop request key dedupe', () => {
  function buildRequestKeyMocks() {
    let sessionCounter = 0
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test',
          directory: '/tmp/wt/abc',
          branch: 'opencode/abc',
          type: 'worktree',
          name: 'opencode/abc',
          extra: null,
          projectID: PROJECT_ID,
          timeUsed: Date.now(),
        }),
        warp: async () => {},
      },
      session: {
        create: async () => ({ id: `session_test_${++sessionCounter}` }),
        get: async () => ({}),
      },
    })

    const sandboxManager = {
      docker: {} as any,
      start: vi.fn().mockResolvedValue({ containerName: 'opencode-forge-sandbox-test' }),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

    return { client, sandboxManager }
  }

  function buildRequestKeyService(
    db: ReturnType<typeof createTestDb>['db'],
    mocks: ReturnType<typeof buildRequestKeyMocks>,
  ) {
    const built = buildExecutionDeps(db, {
      client: mocks.client,
      gitService: mockGitService,
      sandboxManager: mocks.sandboxManager as any,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(built.loopService, baseName, isTaken),
      },
    })
    return { ...built, service: createForgeExecutionService(built.deps) }
  }

  test('a repeated request key returns the same loop without creating anything', async () => {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const db = testDb.db
    const mocks = buildRequestKeyMocks()
    const firstInstance = buildRequestKeyService(db, mocks)
    const secondInstance = buildRequestKeyService(db, mocks)

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const command = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Keyed Plan\n\nDo the thing.' },
      requestKey: 'req-1',
    }

    const first = await firstInstance.service.dispatch(ctx, command)
    const second = await secondInstance.service.dispatch(ctx, command)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.data.loopName).toBe(first.data.loopName)
    expect(second.data.sessionId).toBe(first.data.sessionId)
    expect(second.data.worktreeBranch).toBe(first.data.worktreeBranch)
    expect(second.data.worktreeDir).toBe(first.data.worktreeDir)
    expect(first.data.status).toBe('running')
    expect(first.data.deduped).toBeUndefined()
    expect(second.data.deduped).toBe(true)
    expect(second.data.status).toBe('running')

    expect(mocks.client.workspace.create).toHaveBeenCalledTimes(1)
    expect(mocks.client.session.create).toHaveBeenCalledTimes(1)
    expect(firstInstance.loopsRepo.listAll(PROJECT_ID)).toHaveLength(1)
  })

  test('a same-key start after cancellation returns the cancelled loop without creating anything', async () => {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const db = testDb.db
    const mocks = buildRequestKeyMocks()
    const firstInstance = buildRequestKeyService(db, mocks)
    const secondInstance = buildRequestKeyService(db, mocks)

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const command = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Cancel Keyed Plan\n\nDo the thing.' },
      requestKey: 'req-cancel',
    }

    const first = await firstInstance.service.dispatch(ctx, command)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    firstInstance.loopService.terminate(first.data.loopName, {
      status: 'cancelled',
      reason: 'user_aborted',
      completedAt: Date.now(),
    })

    const second = await secondInstance.service.dispatch(ctx, command)

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.loopName).toBe(first.data.loopName)
    expect(second.data.deduped).toBe(true)
    expect(second.data.status).toBe('cancelled')

    expect(mocks.client.workspace.create).toHaveBeenCalledTimes(1)
    expect(mocks.client.session.create).toHaveBeenCalledTimes(1)
    expect(secondInstance.loopsRepo.listAll(PROJECT_ID)).toHaveLength(1)
  })

  test('a start without a request key still gets a suffixed name on the second start', async () => {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const db = testDb.db
    const mocks = buildRequestKeyMocks()
    const instance = buildRequestKeyService(db, mocks)

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const command = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Suffix Plan\n\nDo the thing.' },
    }

    const first = await instance.service.dispatch(ctx, command)
    const second = await instance.service.dispatch(ctx, command)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.data.loopName).not.toBe(first.data.loopName)
    expect(second.data.loopName.startsWith('suffix-plan')).toBe(true)
    expect(second.data.deduped).toBeUndefined()

    expect(mocks.client.workspace.create).toHaveBeenCalledTimes(2)
    expect(mocks.client.session.create).toHaveBeenCalledTimes(2)
  })
})

describe('handleStartLoop variant config fallback', () => {
  const PROJECT_ID = 'test-project'

  test('falls back to config variants when command has no variants', async () => {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const db = testDb.db
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test', directory: '/tmp/wt/abc', branch: 'opencode/abc',
        }),
        warp: async () => {},
      },
      session: {
        create: async () => ({ id: 'session_test' }),
        get: async () => ({}),
      },
    })

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const { deps, loopService } = buildExecutionDeps(db, {
      client,
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
        executionVariant: 'high',
        auditorVariant: 'audit-high',
      },
      gitService: mockGitService,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nVariant fallback test.' },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const state = loopService.getActiveState(result.data.loopName)
    expect(state).not.toBeNull()
    expect(state!.executionVariant).toBe('high')
    expect(state!.auditorVariant).toBe('audit-high')
  })

  test('preserves explicit empty string variant over config', async () => {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const db = testDb.db
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test', directory: '/tmp/wt/abc', branch: 'opencode/abc',
        }),
        warp: async () => {},
      },
      session: {
        create: async () => ({ id: 'session_test' }),
        get: async () => ({}),
      },
    })

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const { deps, loopService } = buildExecutionDeps(db, {
      client,
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
        executionVariant: 'high',
        auditorVariant: 'audit-high',
      },
      gitService: mockGitService,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(loopService, baseName, isTaken),
      },
    })
    const service = createForgeExecutionService(deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nExplicit empty variant test.' },
        executionVariant: '',
        auditorVariant: '',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const state = loopService.getActiveState(result.data.loopName)
    expect(state).not.toBeNull()
    // Empty string from command should be preserved, not replaced by config
    expect(state!.executionVariant).toBe('')
    expect(state!.auditorVariant).toBe('')
  })
})

describe('handleStartLoop base ref, branch, and base commit', () => {
  function buildHarness(
    workspaceCreate?: () => Promise<Record<string, unknown>>,
    overrides: { gitService?: any; logger?: Logger; loop?: Record<string, unknown> } = {},
  ) {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const db = testDb.db
    const { client } = createFakeForgeClient({
      workspace: {
        create: workspaceCreate ?? (async () => ({ id: 'ws_base', directory: '/tmp/wt/base', branch: 'forge/base-loop' })),
        warp: async () => {},
      },
      session: {
        create: async () => ({ id: 'sess-base' }),
        get: async () => ({}),
      },
    })
    const built = buildExecutionDeps(db, {
      client,
      gitService: overrides.gitService ?? mockGitService,
      logger: overrides.logger ?? mockLogger,
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(built.loopService, baseName, isTaken),
        ...(overrides.loop ?? {}),
      },
    })
    return { ...built, client, db }
  }

  test('forwards baseRef to workspace creation and persists the resolved base commit', async () => {
    const h = buildHarness()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Based Plan\n\nBody.' },
        baseRef: 'refs/heads/forge/prior-loop',
      },
    )

    expect(result.ok).toBe(true)
    expect(h.client.workspace.create).toHaveBeenCalledWith(
      expect.objectContaining({ extra: expect.objectContaining({ baseRef: 'refs/heads/forge/prior-loop' }) }),
    )
    if (!result.ok) return
    expect(h.loopsRepo.get(PROJECT_ID, result.data.loopName)!.baseCommit).toBe(MOCK_BASE_COMMIT)
    expect(h.loopService.getActiveState(result.data.loopName)!.baseCommit).toBe(MOCK_BASE_COMMIT)
  })

  async function dispatchBranchStart(
    gitOverrides: Record<string, unknown>,
    commandExtra: { branch?: string; baseRef?: string },
  ) {
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const h = buildHarness(undefined, { gitService: { ...mockGitService, ...gitOverrides } })
    const service = createForgeExecutionService(h.deps)
    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Branch Plan\n\nBody.' },
        ...commandExtra,
      },
    )
    return { h, result }
  }

  function expectBranchRefused(h: ReturnType<typeof buildHarness>, result: Awaited<ReturnType<typeof dispatchBranchStart>>['result']) {
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('bad_request')
    expect(h.client.workspace.create).not.toHaveBeenCalled()
    expect(h.client.session.create).not.toHaveBeenCalled()
  }

  test('forwards an explicit branch and baseRef and persists the branch', async () => {
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const h = buildHarness(async () => ({ id: 'ws_custom', directory: '/tmp/wt/custom', branch: 'feature/loop' }))
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Custom Branch Plan\n\nBody.' },
        branch: 'feature/loop',
        baseRef: 'refs/heads/main',
      },
    )

    expect(result.ok).toBe(true)
    expect(h.client.workspace.create).toHaveBeenCalledWith(
      expect.objectContaining({ extra: expect.objectContaining({ branch: 'feature/loop', baseRef: 'refs/heads/main' }) }),
    )
    if (!result.ok) return
    expect(result.data.worktreeBranch).toBe('feature/loop')
    expect(h.loopsRepo.get(PROJECT_ID, result.data.loopName)!.worktreeBranch).toBe('feature/loop')
    expect(h.loopService.getActiveState(result.data.loopName)!.worktreeBranch).toBe('feature/loop')
  })

  test('a start without branch or baseRef sends neither extra key', async () => {
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const h = buildHarness()
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Plain Plan\n\nBody.' },
      },
    )

    expect(result.ok).toBe(true)
    const createArgs = (h.client.workspace.create as any).mock.calls[0][0]
    expect(createArgs.extra).not.toHaveProperty('branch')
    expect(createArgs.extra).not.toHaveProperty('baseRef')
  })

  test('refuses a start with an invalid branch name before creating anything', async () => {
    const { h, result } = await dispatchBranchStart(
      { checkRefFormatBranch: () => ({ ok: false, status: 128, stdout: '', stderr: 'fatal: invalid' }) },
      { branch: 'bad branch' },
    )
    expectBranchRefused(h, result)
  })

  test('refuses a start with a branch checked out in another worktree', async () => {
    const { h, result } = await dispatchBranchStart(
      {
        worktreeList: () => ({
          ok: true,
          status: 0,
          stdout: 'worktree /tmp/wt/other\nHEAD abc123\nbranch refs/heads/feature/taken\n',
          stderr: '',
        }),
      },
      { branch: 'feature/taken' },
    )
    expectBranchRefused(h, result)
  })

  test('refuses a start whose branch diverged from the base ref', async () => {
    const { h, result } = await dispatchBranchStart(
      {
        branchExists: (_cwd: string, branch: string) => branch === 'feature/diverged',
        isAncestor: () => false,
      },
      { branch: 'feature/diverged', baseRef: 'refs/heads/main' },
    )
    expectBranchRefused(h, result)
  })

  test('refuses a start whose baseRef does not resolve', async () => {
    const { h, result } = await dispatchBranchStart(
      { revParse: () => ({ ok: false, status: 128, stdout: '', stderr: 'unknown ref' }) },
      { baseRef: 'refs/heads/missing' },
    )
    expectBranchRefused(h, result)
  })

  test('rolls back the start when the base commit cannot be resolved', async () => {
    const failingGit = { revParseHead: () => ({ ok: false, status: 128, stdout: '', stderr: 'not a repo' }), branchExists: () => false }
    const h = buildHarness(undefined, { gitService: failingGit })
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# No Base Plan\n\nBody.' },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('Failed to resolve loop base commit')
    expect(h.client.workspace.remove).toHaveBeenCalled()
    expect(h.loopService.listActive()).toHaveLength(0)
  })

  const PREVIOUS_BRANCH_TIP = 'b'.repeat(40)
  const MOVED_BRANCH_TIP = 'c'.repeat(40)

  function buildBranchMovingGit(options: {
    branch: string
    branchExists: boolean
    headResolves: boolean
  }) {
    let workspaceCreated = false
    const git = {
      ...mockGitService,
      branchExists: (_cwd: string, branch: string) => options.branchExists && branch === options.branch,
      isAncestor: () => true,
      revParse: vi.fn((_cwd: string, ref: string) =>
        ref === `refs/heads/${options.branch}`
          ? {
              ok: true,
              status: 0,
              stdout: `${workspaceCreated ? MOVED_BRANCH_TIP : PREVIOUS_BRANCH_TIP}\n`,
              stderr: '',
            }
          : { ok: true, status: 0, stdout: `${MOVED_BRANCH_TIP}\n`, stderr: '' },
      ),
      revParseHead: () =>
        options.headResolves
          ? { ok: true, status: 0, stdout: `${MOCK_BASE_COMMIT}\n`, stderr: '' }
          : { ok: false, status: 128, stdout: '', stderr: 'not a repo' },
      branchForceUpdate: vi.fn(() => ({ ok: true, status: 0, stdout: '', stderr: '' })),
    }
    return { git, markWorkspaceCreated: () => { workspaceCreated = true } }
  }

  test('restores an existing branch to its pre-start tip when the start fails after workspace creation', async () => {
    const branch = 'feature/loop'
    const { git, markWorkspaceCreated } = buildBranchMovingGit({ branch, branchExists: true, headResolves: false })
    const h = buildHarness(async () => {
      markWorkspaceCreated()
      return { id: 'ws_restore', directory: '/tmp/wt/restore', branch }
    }, { gitService: git })
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Restore Plan\n\nBody.' },
        branch,
        baseRef: 'refs/heads/main',
      },
    )

    expect(result.ok).toBe(false)
    expect(git.branchForceUpdate).toHaveBeenCalledTimes(1)
    expect(git.branchForceUpdate).toHaveBeenCalledWith('/tmp/test', branch, PREVIOUS_BRANCH_TIP)
  })

  test('restores an existing branch to its pre-start tip when workspace.create rejects', async () => {
    const branch = 'feature/loop'
    const { git, markWorkspaceCreated } = buildBranchMovingGit({ branch, branchExists: true, headResolves: true })
    const h = buildHarness(async () => {
      markWorkspaceCreated()
      throw new Error('git worktree add failed')
    }, { gitService: git })
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Throwing Create Plan\n\nBody.' },
        branch,
        baseRef: 'refs/heads/main',
      },
    )

    expect(result.ok).toBe(false)
    expect(git.branchForceUpdate).toHaveBeenCalledTimes(1)
    expect(git.branchForceUpdate).toHaveBeenCalledWith('/tmp/test', branch, PREVIOUS_BRANCH_TIP)
  })

  test('never restores the branch when the start succeeds', async () => {
    const branch = 'feature/loop'
    const { git, markWorkspaceCreated } = buildBranchMovingGit({ branch, branchExists: true, headResolves: true })
    const h = buildHarness(async () => {
      markWorkspaceCreated()
      return { id: 'ws_ok', directory: '/tmp/wt/ok', branch }
    }, { gitService: git })
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Success Plan\n\nBody.' },
        branch,
        baseRef: 'refs/heads/main',
      },
    )

    expect(result.ok).toBe(true)
    expect(git.branchForceUpdate).not.toHaveBeenCalled()
  })

  test('neither captures nor restores a branch that does not exist yet', async () => {
    const branch = 'feature/new'
    const { git, markWorkspaceCreated } = buildBranchMovingGit({ branch, branchExists: false, headResolves: false })
    const h = buildHarness(async () => {
      markWorkspaceCreated()
      return { id: 'ws_new', directory: '/tmp/wt/new', branch }
    }, { gitService: git })
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# New Branch Plan\n\nBody.' },
        branch,
        baseRef: 'refs/heads/main',
      },
    )

    expect(result.ok).toBe(false)
    expect(git.revParse.mock.calls.map((call: [string, string]) => call[1])).not.toContain(`refs/heads/${branch}`)
    expect(git.branchForceUpdate).not.toHaveBeenCalled()
  })

  test('a concurrent duplicate start with an explicit branch returns the deduped result, not the checked-out refusal', async () => {
    let workspaceCreateStarted = false
    let releaseWorkspaceCreate: () => void = () => {}
    const workspaceCreateGate = new Promise<void>((resolve) => {
      releaseWorkspaceCreate = resolve
    })

    let resolveDedupeLogged: () => void = () => {}
    const dedupeLogged = new Promise<void>((resolve) => {
      resolveDedupeLogged = resolve
    })
    const logger: Logger = {
      log: (message: string) => {
        if (message.includes('concurrent start suppressed')) resolveDedupeLogged()
      },
      error: () => {},
      debug: () => {},
    }

    const gitService = {
      ...mockGitService,
      worktreeList: () => ({
        ok: true,
        status: 0,
        stdout: workspaceCreateStarted
          ? 'worktree /tmp/wt/race\nHEAD abc123\nbranch refs/heads/feature/race\n'
          : '',
        stderr: '',
      }),
    }

    const h = buildHarness(async () => {
      workspaceCreateStarted = true
      await workspaceCreateGate
      return { id: 'ws_race', directory: '/tmp/wt/race', branch: 'feature/race' }
    }, { gitService, logger })

    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(h.deps)

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const command = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Race Plan\n\nBody.' },
      hostSessionId: 'host-race',
      branch: 'feature/race',
    }

    const first = service.dispatch(ctx, command)
    await vi.waitFor(() => expect(workspaceCreateStarted).toBe(true))

    const second = service.dispatch(ctx, command)
    const secondOutcome = await Promise.race([
      second.then((result) => result),
      dedupeLogged.then(() => null),
    ])
    releaseWorkspaceCreate()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondOutcome).toBeNull()
    expect(firstResult.ok).toBe(true)
    expect(secondResult.ok).toBe(true)
    if (!secondResult.ok) return
    expect((secondResult.data as { deduped?: boolean }).deduped).toBe(true)
    expect(h.client.workspace.create).toHaveBeenCalledTimes(1)
  })

  test('skips a name whose forge branch already exists', async () => {
    const h = buildHarness(undefined, {
      gitService: { ...mockGitService, branchExists: (_cwd: string, branch: string) => branch === 'forge/taken-branch' },
    })
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Taken Plan\n\nBody.' },
        loopName: 'taken-branch',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.loopName).toBe('taken-branch-1')
  })

  test('answers the start before the code-graph snapshot and records the first prompt when it resolves', async () => {
    const planText = '<!-- forge-section -->\n## Setup\n### Files\n- package.json\nInstall.\n<!-- forge-section -->\n## Build\n### Files\n- src/index.ts\nCompile.'
    let resolveStarted = (): void => {}
    const snapshotStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let resolveSnapshot = (): void => {}
    const pending = new Promise<void>((resolve) => {
      resolveSnapshot = resolve
    })

    const h = buildHarness(undefined, {
      loop: {
        snapshotSectionCodeGraph: () => {
          resolveStarted()
          return pending
        },
      },
    })
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.start' as const, source: { kind: 'inline', planText } },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.sessionId).toBe('sess-base')
    expect(result.data.loopName).toBe('setup')
    expect(result.data.worktreeBranch).toBe('forge/base-loop')
    expect(result.data.worktreeDir).toBe('/tmp/wt/base')
    expect(result.data.workspaceId).toBe('ws_base')

    await snapshotStarted
    expect(h.client.session.promptAsync).not.toHaveBeenCalled()

    resolveSnapshot()
    await vi.waitFor(() => expect(h.client.session.promptAsync).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(h.loopsRepo.get(PROJECT_ID, result.data.loopName)!.firstPromptSentAt).not.toBeNull(),
    )
  })

  test('a failing first prompt after the reply terminates first_prompt_failed and keeps the restartable worktree row', async () => {
    const notifySpy = vi.fn()
    const h = buildHarness()
    h.client.session.promptAsync.mockRejectedValue(new Error('network timeout'))

    const serviceWithNotify = createLoopService(
      h.loopsRepo,
      h.plansRepo,
      h.reviewFindingsRepo,
      PROJECT_ID,
      h.deps.logger,
      undefined,
      notifySpy,
      h.sectionPlansRepo,
      createLoopTransitionsRepo(h.db),
    )
    h.deps.loop.service = serviceWithNotify
    h.deps.loop.terminate = vi.fn(async (name: string, reason: any) => {
      h.loopsRepo.terminate(PROJECT_ID, name, {
        status: 'errored',
        reason: reason.kind === 'first_prompt_failed' ? `first_prompt_failed: ${reason.message}` : reason.kind,
        completedAt: Date.now(),
      })
      notifySpy('settled', name)
      return true
    })

    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(h.deps)

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.start' as const, source: { kind: 'inline', planText: '# Failing Prompt Plan\n\nBody.' } },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    await vi.waitFor(() => expect(h.loopsRepo.get(PROJECT_ID, result.data.loopName)!.status).toBe('errored'))

    const row = h.loopsRepo.get(PROJECT_ID, result.data.loopName)!
    expect(row.terminationReason).toMatch(/^first_prompt_failed: /)
    expect(row.worktree).toBe(true)
    expect(row.worktreeDir).toBeTruthy()
    expect(h.deps.loop.terminate).toHaveBeenCalledWith(result.data.loopName, {
      kind: 'first_prompt_failed',
      message: 'network timeout',
    })
    expect(notifySpy).toHaveBeenCalledWith('settled', result.data.loopName)
  })
})

describe('handleStartLoop section graph validation', () => {
  function buildSectionHarness() {
    const testDb = createTestDb()
    openDbs.push(testDb)
    const db = testDb.db
    const branchExists = vi.fn(() => false)
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({ id: 'ws_sections', directory: '/tmp/wt/sections', branch: 'forge/sections-loop' }),
        warp: async () => {},
      },
      session: {
        create: async () => ({ id: 'sess-sections' }),
        get: async () => ({}),
      },
    })
    const built = buildExecutionDeps(db, {
      client,
      gitService: { ...mockGitService, branchExists },
      loop: {
        generateUniqueLoopName: (baseName, isTaken) => uniqueLoopNameFor(built.loopService, baseName, isTaken),
      },
    })
    return { ...built, client, branchExists }
  }

  test('an invalid graph returns 400 bad_request listing every error and creates nothing', async () => {
    const h = buildSectionHarness()
    const service = createForgeExecutionService(h.deps)

    const planText = [
      '<!-- forge-section id="a" -->',
      '## Phase 1',
      '',
      'Body 1.',
      '<!-- forge-section id="b" after="c" -->',
      '## Phase 2',
      '',
      'Body 2.',
      '<!-- forge-section id="b" after="missing,a" -->',
      '## Phase 3',
      '',
      'Body 3.',
      '<!-- forge-section id="c" -->',
      '## Phase 4',
      '',
      'Body 4.',
    ].join('\n')

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.start' as const, source: { kind: 'inline', planText } },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('bad_request')
    expect(result.error.message).toContain('Plan section graph is invalid')
    expect(result.error.message).toContain('depends on "c", which is section 4')
    expect(result.error.message).toContain('reuses id "b"')
    expect(result.error.message).toContain('depends on unknown id "missing"')
    expect(h.client.workspace.create).not.toHaveBeenCalled()
    expect(h.client.session.create).not.toHaveBeenCalled()
    expect(h.branchExists).not.toHaveBeenCalled()
    expect(h.loopService.listActive()).toHaveLength(0)
  })

  test('a plan over MAX_TOTAL_SECTIONS returns 400 bad_request and creates nothing', async () => {
    const h = buildSectionHarness()
    const service = createForgeExecutionService(h.deps)

    const planText = Array.from({ length: MAX_TOTAL_SECTIONS + 1 }, (_, i) =>
      [
        '<!-- forge-section -->',
        `## Phase ${i + 1}`,
        '',
        `Body ${i + 1}.`,
      ].join('\n'),
    ).join('\n')

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.start' as const, source: { kind: 'inline', planText } },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('bad_request')
    expect(result.error.message).toContain('Plan section graph is invalid')
    expect(result.error.message).toContain(`exceed the cap of ${MAX_TOTAL_SECTIONS}`)
    expect(h.client.workspace.create).not.toHaveBeenCalled()
    expect(h.client.session.create).not.toHaveBeenCalled()
    expect(h.loopService.listActive()).toHaveLength(0)
  })

  test('a valid diamond persists the four rows with their ids and after edges', async () => {
    const h = buildSectionHarness()
    const service = createForgeExecutionService(h.deps)

    const planText = [
      '<!-- forge-section id="a" -->',
      '## Phase A',
      '',
      'Body A.',
      '<!-- forge-section id="b" after="a" -->',
      '## Phase B',
      '',
      'Body B.',
      '<!-- forge-section id="c" after="a" -->',
      '## Phase C',
      '',
      'Body C.',
      '<!-- forge-section id="d" after="b,c" -->',
      '## Phase D',
      '',
      'Body D.',
    ].join('\n')

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      { type: 'loop.start' as const, source: { kind: 'inline', planText } },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const rows = h.sectionPlansRepo.list(PROJECT_ID, result.data.loopName)
    expect(rows.map((row) => ({ id: row.sectionId, after: row.dependsOn }))).toEqual([
      { id: 'a', after: [] },
      { id: 'b', after: ['a'] },
      { id: 'c', after: ['a'] },
      { id: 'd', after: ['b', 'c'] },
    ])
    expect(rows[0].status).toBe('in_progress')
    expect(h.loopService.getActiveState(result.data.loopName)!.totalSections).toBe(4)
  })
})
