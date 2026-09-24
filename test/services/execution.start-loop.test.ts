import { describe, test, expect, beforeEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import { buildLoopPermissionRuleset, resolveLoopAllowedDirectories, resolveLoopPermissionOptions } from '../../src/constants/loop'
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
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
          permission: buildLoopPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories({}) }),
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
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
      plansRepo,
      loopsRepo,
      loop: {
        service: loopService,
        listActive: (...args: any[]) => loopService.listActive(...args),
        generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
      plansRepo, loopsRepo, loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
      plansRepo, loopsRepo, loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
      plansRepo, loopsRepo, loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
      plansRepo, loopsRepo, loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
      plansRepo, loopsRepo, loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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

describe('handleStartGoal creates dedicated code session', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo

  const noopFn = () => {}

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-start-goal-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
  })

  function goalClient(overrides?: any) {
    return createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_goal',
          directory: '/tmp/wt/goal',
          branch: 'opencode/goal',
          type: 'worktree',
          name: 'opencode/goal',
          extra: null,
          projectID: PROJECT_ID,
          timeUsed: Date.now(),
        }),
      },
      session: {
        create: async () => ({ id: 'new-goal-session' }),
        promptAsync: async () => {},
      },
      ...overrides,
    })
  }

  async function buildService(client: any, loopHandlerOverrides: any = {}, sandboxManager?: any) {
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn,
      clearLoopTimers: noopFn,
      ...loopHandlerOverrides,
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
      plansRepo,
      loopsRepo,
      loop: {
        service: loopService,
        listActive: (...args: any[]) => loopService.listActive(...args),
        generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
        findMatchByName: (...args: any[]) => loopService.findMatchByName(...args),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
        handleAuditorProviderLimit: async () => false,
      } as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      client,
      sandboxManager,
      pendingTeardowns: mockPendingTeardowns,
    })

    return { service, loopService }
  }

  test('creates workspace + new session with worktree/workspace/permissions, sends initial prompt, and sets state IDs to new session', async () => {
    const { client } = goalClient()
    const { service, loopService } = await buildService(client)

    const invokingSessionId = 'invoker-session-1'
    const result = await service.dispatch(
      { surface: 'tool', projectId: PROJECT_ID, directory: '/tmp/test', sourceSessionId: invokingSessionId },
      {
        type: 'goal.start' as const,
        goal: 'Refactor the storage layer for goal loops',
        executorSessionId: invokingSessionId,
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // ---- session.create was called with worktree directory, workspace, and loop permissions ----
    expect(client.session.create).toHaveBeenCalledTimes(1)
    const sessionCreateArgs = (client.session.create as any).mock.calls[0][0]
    expect(sessionCreateArgs.directory).toBe('/tmp/wt/goal')
    expect(sessionCreateArgs.workspaceID).toBe('ws_goal')
    expect(sessionCreateArgs.permission).toEqual(
      buildLoopPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories({}) }),
    )

    // The new session ID is returned in the result
    const newSessionId = 'new-goal-session'
    expect(result.data.sessionId).toBe(newSessionId)

    // ---- Initial prompt contains original goal, uses worktree directory, workspace, and code model ----
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    const promptArgs = (client.session.promptAsync as any).mock.calls[0][0]
    expect(promptArgs.sessionID).toBe(newSessionId)
    expect(promptArgs.directory).toBe('/tmp/wt/goal')
    expect(promptArgs.agent).toBe('code')
    expect(promptArgs.parts[0].text).toContain('## Goal\nRefactor the storage layer for goal loops')
    expect(promptArgs.parts[0].text).toContain('Implement the goal above directly in this worktree')
    expect(promptArgs.workspace).toBe('ws_goal')

    // ---- State IDs use the new session for both sessionId and executorSessionId ----
    const state = loopService.getActiveState(result.data.loopName)
    expect(state).not.toBeNull()
    expect(state!.sessionId).toBe(newSessionId)
    expect(state!.executorSessionId).toBe(newSessionId)
    expect(state!.hostSessionId).toBe(invokingSessionId)
    expect(state!.kind).toBe('goal')
    expect(state!.goal).toBe('Refactor the storage layer for goal loops')
    expect(state!.workspaceId).toBe('ws_goal')
    expect(state!.worktreeDir).toBe('/tmp/wt/goal')
    expect(state!.worktreeBranch).toBe('opencode/goal')

    // ---- Source/invoking session is never warped or mutated ----
    // workspace.warp is called internally by createLoopSessionWithWorkspace →
    // bindSessionToWorkspace for the NEW session (not the invoking session)
    expect(client.workspace.warp).toHaveBeenCalledTimes(1)
    expect((client.workspace.warp as any).mock.calls[0][0]).toEqual({
      id: 'ws_goal',
      sessionID: newSessionId,
    })
    expect(client.session.update).not.toHaveBeenCalled()

    // ---- Invoking session's turn is aborted after successful launch so its
    // agent cannot keep implementing the goal in the original directory ----
    expect(client.session.abort).toHaveBeenCalledTimes(1)
    expect((client.session.abort as any).mock.calls[0][0]).toEqual({ sessionID: invokingSessionId })

    // Goal text persisted in loop_large_fields, NOT in the plans table
    const largeFields = loopsRepo.getLarge(PROJECT_ID, result.data.loopName)
    expect(largeFields).not.toBeNull()
    expect(largeFields!.goal).toBe('Refactor the storage layer for goal loops')

    const planRow = plansRepo.getForLoop(PROJECT_ID, result.data.loopName)
    expect(planRow).toBeNull()

    db.close()
  })

  test('applies loop permissions via createLoopSessionWithWorkspace, starts sandbox before prompting for the new session', async () => {
    const { client } = goalClient()
    const sandboxManager = {
      start: vi.fn().mockResolvedValue({ containerName: 'goal-sandbox' }),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null),
      isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0),
      restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }
    const { service, loopService } = await buildService(client, {}, sandboxManager)

    const invokingSessionId = 'invoker-session-sandboxed'
    const result = await service.dispatch(
      { surface: 'tool', projectId: PROJECT_ID, directory: '/tmp/test', sourceSessionId: invokingSessionId },
      {
        type: 'goal.start' as const,
        goal: 'Run this goal with sandbox isolation',
        executorSessionId: invokingSessionId,
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Permissions passed to session.create, NOT via session.update
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: buildLoopPermissionRuleset({ allowDirectories: resolveLoopAllowedDirectories({}) }),
      }),
    )
    expect(client.session.update).not.toHaveBeenCalled()

    // Sandbox started after session create, before prompt
    expect(sandboxManager.start).toHaveBeenCalledWith(result.data.loopName, '/tmp/wt/goal')
    const sandboxCallOrder = sandboxManager.start.mock.invocationCallOrder[0]
    const sessionCreateCallOrder = (client.session.create as any).mock.invocationCallOrder[0]
    expect(sessionCreateCallOrder).toBeLessThan(sandboxCallOrder)

    // promptAsync called after sandbox start
    expect(client.session.promptAsync).toHaveBeenCalled()
    const promptCallOrder = (client.session.promptAsync as any).mock.invocationCallOrder[0]
    expect(sandboxCallOrder).toBeLessThan(promptCallOrder)

    expect(loopService.getActiveState(result.data.loopName)).toMatchObject({
      sandbox: true,
      sandboxContainer: 'goal-sandbox',
      sessionId: 'new-goal-session',
      executorSessionId: 'new-goal-session',
    })

    db.close()
  })

  test('goal text survives reload (fresh loop service) without creating a plans-table record', async () => {
    const { client } = goalClient()
    const { service } = await buildService(client)

    const invokingSessionId = 'invoker-session-2'
    const result = await service.dispatch(
      { surface: 'tool', projectId: PROJECT_ID, directory: '/tmp/test', sourceSessionId: invokingSessionId },
      {
        type: 'goal.start' as const,
        goal: 'Refactor the storage layer for goal loops',
        executorSessionId: invokingSessionId,
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const loopName = result.data.loopName

    // Simulate a restart/reload: a brand-new loop service reading the same DB
    const reloadedService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)
    const reloaded = reloadedService.getAnyState(loopName)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.kind).toBe('goal')
    expect(reloaded!.goal).toBe('Refactor the storage layer for goal loops')
    // The new session ID is persisted
    expect(reloaded!.sessionId).toBe('new-goal-session')

    // Still no plan row after reload
    expect(plansRepo.getForLoop(PROJECT_ID, loopName)).toBeNull()

    db.close()
  })

  test('rollback on session create failure removes workspace but never aborts the invoking session', async () => {
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_goal_create_fail',
          directory: '/tmp/wt/goal-create-fail',
          branch: 'opencode/goal-create-fail',
          type: 'worktree',
          name: 'opencode/goal-create-fail',
          extra: null,
          projectID: PROJECT_ID,
          timeUsed: Date.now(),
        }),
      },
      session: {
        create: async () => { throw new Error('session.create rejected') },
      },
    })
    const { service, loopService } = await buildService(client)

    const invokingSessionId = 'invoker-session-3'
    const result = await service.dispatch(
      { surface: 'tool', projectId: PROJECT_ID, directory: '/tmp/test', sourceSessionId: invokingSessionId },
      {
        type: 'goal.start' as const,
        goal: 'Goal that fails session create',
        executorSessionId: invokingSessionId,
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error')
    }

    // Never abort the invoking/host session
    expect(client.session.abort).not.toHaveBeenCalled()

    // Newly-created workspace is removed during rollback
    expect(client.workspace.remove).toHaveBeenCalledTimes(1)
    expect((client.workspace.remove as any).mock.calls[0][0]).toEqual({ id: 'ws_goal_create_fail' })

    // Loop state must not be persisted
    const active = loopService.listActive().filter((s) => s.goal)
    expect(active.length).toBe(0)

    db.close()
  })

  test('rollback on prompt failure aborts only the created goal session, never the invoking session', async () => {
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_goal_prompt_fail',
          directory: '/tmp/wt/goal-prompt-fail',
          branch: 'opencode/goal-prompt-fail',
          type: 'worktree',
          name: 'opencode/goal-prompt-fail',
          extra: null,
          projectID: PROJECT_ID,
          timeUsed: Date.now(),
        }),
      },
      session: {
        create: async () => ({ id: 'goal-session-to-abort' }),
        promptAsync: async () => { throw new Error('prompt failed') },
      },
    })
    const { service, loopService } = await buildService(client)

    const invokingSessionId = 'invoker-session-4'
    const result = await service.dispatch(
      { surface: 'tool', projectId: PROJECT_ID, directory: '/tmp/test', sourceSessionId: invokingSessionId },
      {
        type: 'goal.start' as const,
        goal: 'Goal that fails prompt',
        executorSessionId: invokingSessionId,
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('prompt_failed')
    }

    // The CREATED goal session is aborted during rollback
    expect(client.session.abort).toHaveBeenCalledTimes(1)
    expect((client.session.abort as any).mock.calls[0][0]).toEqual({ sessionID: 'goal-session-to-abort' })

    // Workspace removed during rollback
    expect(client.workspace.remove).toHaveBeenCalledTimes(1)

    // Loop state must not be persisted
    const active = loopService.listActive().filter((s) => s.goal)
    expect(active.length).toBe(0)

    db.close()
  })

  test('rejects a blank/whitespace goal before any workspace provisioning', async () => {
    const { client } = goalClient()
    const { service } = await buildService(client)

    const result = await service.dispatch(
      { surface: 'tool', projectId: PROJECT_ID, directory: '/tmp/test', sourceSessionId: 'invoker-session-5' },
      {
        type: 'goal.start' as const,
        goal: '   \n  ',
        executorSessionId: 'invoker-session-5',
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('bad_request')
    }
    expect(client.workspace.create).not.toHaveBeenCalled()
    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.workspace.warp).not.toHaveBeenCalled()

    db.close()
  })

  test.each([
    ['goal.start', { type: 'goal.start' as const, goal: 'Ship it', executorSessionId: 'invoker-6' }],
    ['loop.start', { type: 'loop.start' as const, source: { kind: 'inline' as const, planText: '# Plan\nDo it' }, title: 'Plan' }],
  ])('%s in an uncommitted project (projectId=global) fails fast with a toast and provisions nothing', async (_label, command) => {
    const { client } = goalClient()
    const { service } = await buildService(client)

    const result = await service.dispatch(
      { surface: 'tool', projectId: 'global', directory: '/tmp/test', sourceSessionId: 'invoker-6' },
      command as any,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('bad_request')
      expect(result.error.message).toContain('at least one commit')
    }

    // Nothing provisioned
    expect(client.workspace.create).not.toHaveBeenCalled()
    expect(client.session.create).not.toHaveBeenCalled()

    // Error toast published to the TUI
    expect(client.toast).toHaveBeenCalledTimes(1)
    const toast = (client.toast as any).mock.calls[0][0]
    expect(toast.variant).toBe('error')
    expect(toast.message).toContain('restart opencode')

    db.close()
  })
})

describe('handlePlanNewSession workspace forwarding', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo

  const noopFn = () => {}

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-new-session-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
  })

  test('forwards the created session workspaceID to promptAsync', async () => {
    const { client } = createFakeForgeClient({
      session: {
        create: async () => ({ id: 'new-session-id', workspaceID: 'ws_test' }),
        promptAsync: async () => {},
      },
    })

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
      plansRepo,
      loopsRepo,
      loop: {
          service: loopService,
          listActive: (...args: any[]) => loopService.listActive(...args),
          generateUniqueLoopName: (...args: any[]) => loopService.generateUniqueLoopName(...args),
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
        type: 'plan.execute.newSession' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nThis is a test plan.' },
      },
    )

    expect(result.ok).toBe(true)
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 'new-session-id', workspace: 'ws_test' }),
    )

    db.close()
  })
})
