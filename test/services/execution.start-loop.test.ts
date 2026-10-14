import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createGoalsRepo } from '../../src/storage/repos/goals-repo'
import { createLoopService } from '../../src/loop/service'
import { generateUniqueName } from '../../src/loop/name-uniqueness'
import { createForgeExecutionService } from '../../src/services/execution'
import type { Logger } from '../../src/types'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import { buildLoopPermissionRuleset, resolveLoopPermissionOptions } from '../../src/constants/loop'
import type { PlansRepo } from '../../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import type { LoopService } from '../../src/loop/service'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createFakeForgeClient } from '../helpers/fake-client'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

const mockPendingTeardowns = {
  set: vi.fn(),
  get: vi.fn().mockReturnValue(undefined),
  clear: vi.fn(),
}

const MOCK_BASE_COMMIT = 'a'.repeat(40)

const mockGitService = {
  revParseHead: () => ({ ok: true, status: 0, stdout: `${MOCK_BASE_COMMIT}\n`, stderr: '' }),
  branchExists: () => false,
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

describe('handleStartLoop builtin worktree workspace', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
  let loopService: LoopService

  const noopFn = () => {}

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-start-loop-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      mockLogger,
      undefined,
      undefined,
      sectionPlansRepo,
    )
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

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

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

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
          findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          handleAuditorProviderLimit: async () => false,
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

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
    const loopPlanRow = plansRepo.getForLoop(PROJECT_ID, result.data.loopName)
    expect(loopPlanRow).not.toBeNull()
    expect(loopPlanRow!.content).toBe('# Test Plan\n\nThis is a test plan.')

    // Assert: loop_large_fields has no prompt column (removed in migration 127)
    const largeFields = loopsRepo.getLarge(PROJECT_ID, result.data.loopName)
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

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
          findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          handleAuditorProviderLimit: async () => false,
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      // No sandboxManager passed — simulates Docker not available
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

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

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

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

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
          findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          handleAuditorProviderLimit: async () => false,
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

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
          permission: buildLoopPermissionRuleset(),
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

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

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

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: configuredConfig,
      logger: mockLogger,
      dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
          findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          handleAuditorProviderLimit: async () => false,
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

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

  test('fails and rolls back when sandbox manager present but start throws', async () => {
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

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockRejectedValue(new Error('Docker is not available. Please ensure Docker is running.')),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
          findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          handleAuditorProviderLimit: async () => false,
        } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

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

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: mockLogger,
      dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo,
      loopsRepo,
      loop: {
        service: loopService,
        listActive: (...args: any[]) => loopService.listActive(...args),
        generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
        findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
        handleAuditorProviderLimit: async () => false,
      } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

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
  const noopFn = () => {}

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

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
    }

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
      mockLoopHandler,
      mockSandboxManager,
    }
  }

  test('two concurrent calls with same source produce only one workspace + session', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-dedupe-concurrent-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

    const mocks = buildDedupeMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo, loopsRepo, loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
          findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          handleAuditorProviderLimit: async () => false,
        } as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
      client: mocks.client,
      pendingTeardowns: mockPendingTeardowns,
    })

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

    db.close()
  })

  test('different source sessions do not dedupe each other', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-dedupe-diffsource-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

    const mocks = buildDedupeMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo, loopsRepo, loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
          findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          handleAuditorProviderLimit: async () => false,
        } as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
      client: mocks.client,
      pendingTeardowns: mockPendingTeardowns,
    })

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

    db.close()
  })

  test('sequential second call after first completes is not deduped', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-dedupe-seq-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

    const mocks = buildDedupeMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo, loopsRepo, loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
          findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          handleAuditorProviderLimit: async () => false,
        } as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
      client: mocks.client,
      pendingTeardowns: mockPendingTeardowns,
    })

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

    db.close()
  })
})

describe('handleStartLoop variant config fallback', () => {
  const noopFn = () => {}
  const PROJECT_ID = 'test-project'

  test('falls back to config variants when command has no variants', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-variant-fallback-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

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

    const mockLoopHandler = {
      runExclusive: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn, clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
        executionVariant: 'high',
        auditorVariant: 'audit-high',
      },
      logger: mockLogger, dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo, loopsRepo, loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
          findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          handleAuditorProviderLimit: async () => false,
        } as any, loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

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

    db.close()
  })

  test('preserves explicit empty string variant over config', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-variant-empty-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

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

    const mockLoopHandler = {
      runExclusive: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn, clearLoopTimers: noopFn,
    }

    const { createForgeExecutionService } = await import('../../src/services/execution')

    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
        executionVariant: 'high',
        auditorVariant: 'audit-high',
      },
      logger: mockLogger, dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo, loopsRepo, loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(loopService, baseName, isTaken),
          findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
          registerSessionReverseIndex: () => {},
          unregisterSessionReverseIndex: () => {},
          handleAuditorProviderLimit: async () => false,
        } as any, loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

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

    db.close()
  })
})

describe('handleStartLoop base ref and base commit', () => {
  const noopFn = () => {}

  function buildService(opts: {
    gitService: any
    workspaceCreate?: () => Promise<Record<string, unknown>>
    loopsRepo: LoopsRepo
    plansRepo: PlansRepo
    sectionPlansRepo: SectionPlansRepo
    loopService: LoopService
    client: any
  }) {
    return {
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger,
      dataDir: '/tmp',
      gitService: opts.gitService,
      plansRepo: opts.plansRepo,
      loopsRepo: opts.loopsRepo,
      loop: {
        service: opts.loopService,
        listActive: (...args: any[]) => opts.loopService.listActive(...args),
        generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(opts.loopService, baseName, isTaken),
        findMatchByName: (...args: any[]) => opts.loopService.findMatchByName(...args),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
        handleAuditorProviderLimit: async () => false,
      } as any,
      loopHandler: { runExclusive: async <T>(_n: string, fn: () => Promise<T>) => fn(), startWatchdog: noopFn, clearLoopTimers: noopFn } as any,
      sectionPlansRepo: opts.sectionPlansRepo,
      client: opts.client,
      pendingTeardowns: mockPendingTeardowns,
    }
  }

  function buildHarness() {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-start-base-ref-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({ id: 'ws_base', directory: '/tmp/wt/base', branch: 'forge/base-loop' }),
        warp: async () => {},
      },
      session: {
        create: async () => ({ id: 'sess-base' }),
        get: async () => ({}),
      },
    })
    return { db, loopsRepo, plansRepo, sectionPlansRepo, loopService, client }
  }

  test('forwards baseRef to workspace creation and persists the resolved base commit', async () => {
    const h = buildHarness()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(buildService({
      gitService: mockGitService,
      loopsRepo: h.loopsRepo,
      plansRepo: h.plansRepo,
      sectionPlansRepo: h.sectionPlansRepo,
      loopService: h.loopService,
      client: h.client,
    }))

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

    h.db.close()
  })

  test('rolls back the start when the base commit cannot be resolved', async () => {
    const h = buildHarness()
    const failingGit = { revParseHead: () => ({ ok: false, status: 128, stdout: '', stderr: 'not a repo' }), branchExists: () => false }
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService(buildService({
      gitService: failingGit,
      loopsRepo: h.loopsRepo,
      plansRepo: h.plansRepo,
      sectionPlansRepo: h.sectionPlansRepo,
      loopService: h.loopService,
      client: h.client,
    }))

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

    h.db.close()
  })
})

describe('handleStartLoop goal attach', () => {
  const noopFn = () => {}

  function buildHarness() {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-goal-attach-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const goalsRepo = createGoalsRepo(db)
    const loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      mockLogger,
      undefined,
      undefined,
      sectionPlansRepo,
    )
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({ id: 'ws_goal', directory: '/tmp/wt/goal', branch: 'forge/goal-loop' }),
        warp: async () => {},
      },
      session: {
        create: async () => ({ id: 'sess-goal' }),
        get: async () => ({}),
      },
    })
    return { db, loopsRepo, plansRepo, sectionPlansRepo, goalsRepo, loopService, client }
  }

  function buildDeps(
    h: ReturnType<typeof buildHarness>,
    logger: Logger = mockLogger,
    goalsRepo: any = h.goalsRepo,
  ) {
    return {
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
        executionVariant: 'high',
        auditorVariant: 'audit-high',
      },
      logger,
      dataDir: '/tmp',
      gitService: mockGitService,
      plansRepo: h.plansRepo,
      loopsRepo: h.loopsRepo,
      goalsRepo,
      loop: {
        service: h.loopService,
        listActive: (...args: any[]) => h.loopService.listActive(...args),
        generateUniqueLoopName: (baseName: string, isTaken?: (name: string) => boolean) => uniqueLoopNameFor(h.loopService, baseName, isTaken),
        findMatchByName: (...args: any[]) => h.loopService.findMatchByName(...args),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
        handleAuditorProviderLimit: async () => false,
      } as any,
      loopHandler: {
        runExclusive: async <T>(_n: string, fn: () => Promise<T>) => fn(),
        startWatchdog: noopFn,
        clearLoopTimers: noopFn,
      } as any,
      sectionPlansRepo: h.sectionPlansRepo,
      client: h.client,
      pendingTeardowns: mockPendingTeardowns,
    }
  }

  function saveDraft(h: ReturnType<typeof buildHarness>, hostSessionId: string) {
    return h.goalsRepo.saveDraft({
      projectId: PROJECT_ID,
      goalId: 'goal-draft',
      title: 'Goal title',
      objective: 'Goal objective',
      tasks: [{ title: 'First task' }],
      hostSessionId,
      maxChunks: 3,
    })
  }

  const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }

  test('attaches a draft goal as chunk 1 and snapshots the resolved launch settings', async () => {
    const h = buildHarness()
    saveDraft(h, 'host-goal')
    const service = createForgeExecutionService(buildDeps(h))

    const result = await service.dispatch(ctx, {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Goal Plan\n\nBody.' },
      hostSessionId: 'host-goal',
      maxIterations: 7,
      sandbox: { enabled: false },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.goalId).toBe('goal-draft')

    const goal = h.goalsRepo.getGoal(PROJECT_ID, 'goal-draft')!
    expect(goal.status).toBe('running')
    expect(goal.projectDir).toBe('/tmp/test')
    expect(goal.executionModel).toBe('prov/exec')
    expect(goal.auditorModel).toBe('prov/aud')
    expect(goal.executionVariant).toBe('high')
    expect(goal.auditorVariant).toBe('audit-high')
    expect(goal.sandboxSettings).toEqual({ enabled: false })
    expect(goal.maxIterations).toBe(7)

    const chunks = h.goalsRepo.listChunks(PROJECT_ID, 'goal-draft')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      chunkIndex: 0,
      stage: 'running',
      loopName: result.data.loopName,
      branch: 'forge/goal-loop',
      baseCommit: MOCK_BASE_COMMIT,
      title: result.data.displayName,
    })

    h.db.close()
  })

  test('without a draft goal nothing changes and no goalId is returned', async () => {
    const h = buildHarness()
    const service = createForgeExecutionService(buildDeps(h))

    const result = await service.dispatch(ctx, {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# No Goal\n\nBody.' },
      hostSessionId: 'host-none',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.goalId).toBeUndefined()
    expect(h.goalsRepo.listGoals(PROJECT_ID)).toHaveLength(0)

    h.db.close()
  })

  test('an attachFirstChunk throw is logged and the start still succeeds', async () => {
    const h = buildHarness()
    saveDraft(h, 'host-throw')
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
    const throwingRepo = {
      ...h.goalsRepo,
      attachFirstChunk: () => {
        throw new Error('boom')
      },
    }
    const service = createForgeExecutionService(buildDeps(h, logger, throwingRepo))

    const result = await service.dispatch(ctx, {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Throwing Goal\n\nBody.' },
      hostSessionId: 'host-throw',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.goalId).toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith('handleStartLoop: failed to attach first goal chunk', expect.any(Error))

    h.db.close()
  })

  test('a deduped concurrent start attaches exactly once', async () => {
    const h = buildHarness()
    saveDraft(h, 'host-dedupe')
    const attachFirstChunk = vi.fn(h.goalsRepo.attachFirstChunk.bind(h.goalsRepo))
    const repo = { ...h.goalsRepo, attachFirstChunk }
    const service = createForgeExecutionService(buildDeps(h, mockLogger, repo))

    const command = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Dedupe Goal\n\nBody.' },
      hostSessionId: 'host-dedupe',
    }
    const [r1, r2] = await Promise.all([service.dispatch(ctx, command), service.dispatch(ctx, command)])

    expect(attachFirstChunk).toHaveBeenCalledTimes(1)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(h.goalsRepo.getGoal(PROJECT_ID, 'goal-draft')!.status).toBe('running')

    h.db.close()
  })

  test('skips a name still referenced by a goal chunk and attaches chunk 1 with the suffixed name', async () => {
    const h = buildHarness()
    h.goalsRepo.saveDraft({
      projectId: PROJECT_ID,
      goalId: 'goal-old',
      title: 'Old goal',
      objective: 'Old objective',
      tasks: [{ title: 'Old task' }],
      hostSessionId: 'host-old',
      maxChunks: 3,
    })
    h.goalsRepo.attachFirstChunk(
      PROJECT_ID,
      'host-old',
      {
        projectDir: '/tmp/test',
        executionModel: null,
        auditorModel: null,
        executionVariant: null,
        auditorVariant: null,
        sandboxSettings: null,
        maxIterations: null,
      },
      { loopName: 'shared-name', branch: 'forge/shared-name', title: 'Old chunk', baseCommit: MOCK_BASE_COMMIT },
    )
    saveDraft(h, 'host-new')
    const service = createForgeExecutionService(buildDeps(h))

    const result = await service.dispatch(ctx, {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Shared Plan\n\nBody.' },
      loopName: 'shared-name',
      hostSessionId: 'host-new',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.loopName).toBe('shared-name-1')
    expect(result.data.goalId).toBe('goal-draft')

    const chunks = h.goalsRepo.listChunks(PROJECT_ID, 'goal-draft')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].loopName).toBe('shared-name-1')

    h.db.close()
  })

  test('skips a name whose forge branch already exists', async () => {
    const h = buildHarness()
    const gitWithBranch = {
      ...mockGitService,
      branchExists: (_cwd: string, branch: string) => branch === 'forge/taken-branch',
    }
    const service = createForgeExecutionService({ ...buildDeps(h), gitService: gitWithBranch })

    const result = await service.dispatch(ctx, {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Taken Plan\n\nBody.' },
      loopName: 'taken-branch',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.loopName).toBe('taken-branch-1')

    h.db.close()
  })
})
