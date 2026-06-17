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
import { buildLoopPermissionRuleset } from '../../src/constants/loop'
import type { PlansRepo } from '../../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import type { LoopService } from '../../src/loop/service'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createFakeForgeClient } from '../helpers/fake-client'
import { ForgeClientError } from '../../src/client/port'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

const mockWorkspaceStatusRegistry = {
  recordEvent: vi.fn(),
  getStatus: vi.fn().mockReturnValue('connected' as const),
  awaitConnected: vi.fn().mockResolvedValue({ connected: true, elapsedMs: 0, source: 'cached' as const }),
  primeFromSnapshot: vi.fn(),
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
      tui: {
        selectSession: async () => {},
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
      isLiveByName: vi.fn().mockResolvedValue(false),
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
      loop: loopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nThis is a test plan.' },
        lifecycle: { selectSession: true },
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
    expect(client.tui.selectSession).toHaveBeenCalledWith({ directory: '/tmp/test', sessionID: 'session_test', workspace: 'ws_test' })
    expect((client.workspace.warp as any).mock.invocationCallOrder[0]).toBeLessThan(
      (client.tui.selectSession as any).mock.invocationCallOrder[0],
    )

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
      loop: loopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      // No sandboxManager passed — simulates Docker not available
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nThis is a test plan.' },
        lifecycle: { selectSession: true },
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
      isLiveByName: vi.fn().mockResolvedValue(false),
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
      loop: loopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
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
          lifecycle: { selectSession: false },
        },
      )
      expect(client.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          permission: buildLoopPermissionRuleset(),
        }),
      )
    }
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
      isLiveByName: vi.fn().mockResolvedValue(false),
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
      loop: loopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nThis is a test plan.' },
        lifecycle: { selectSession: true },
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
      tui: {
        selectSession: async () => {},
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
      isLiveByName: vi.fn().mockResolvedValue(false),
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
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client: mocks.client,
      pendingTeardowns: mockPendingTeardowns,
    })

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const command = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Dedupe Plan\n\nTest plan for dedupe.' },
      
      lifecycle: { selectSession: true },
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
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client: mocks.client,
      pendingTeardowns: mockPendingTeardowns,
    })

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const cmd1 = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Plan Alpha\n\nDifferent plan A.' },
      
      lifecycle: { selectSession: true },
      hostSessionId: 'host-A',
    }
    const cmd2 = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Plan Beta\n\nDifferent plan B.' },
      
      lifecycle: { selectSession: true },
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
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client: mocks.client,
      pendingTeardowns: mockPendingTeardowns,
    })

    const ctx = { surface: 'api' as const, projectId: PROJECT_ID, directory: '/tmp/test' }
    const cmd = {
      type: 'loop.start' as const,
      source: { kind: 'inline' as const, planText: '# Sequential Plan\n\nSequential test.' },
      
      lifecycle: { selectSession: true },
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

describe('handleStartLoop select-session ordering', () => {
  const noopFn = () => {}

  function buildOrderingMocks() {
    // Deferred pattern: control when selectSession resolves or rejects
    let resolveSelect!: (value?: unknown) => void
    let rejectSelect!: (reason?: unknown) => void
    const selectPromise = new Promise<void>((resolve, reject) => {
      resolveSelect = () => { resolve(); }
      rejectSelect = (reason) => { reject(reason); }
    })

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
      tui: {
        selectSession: async () => selectPromise,
      },
    })

    const mockLoopHandler = {
      runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
      startWatchdog: noopFn, clearLoopTimers: noopFn,
    }

    const mockSandboxManager = {
      docker: {} as any,
      start: vi.fn().mockResolvedValue({ containerName: 'opencode-forge-sandbox-test' }),
      stop: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn().mockReturnValue(null), isActive: vi.fn().mockReturnValue(false),
      isLive: vi.fn().mockResolvedValue(false), isLiveByName: vi.fn().mockResolvedValue(false),
      cleanupOrphans: vi.fn().mockResolvedValue(0), restore: vi.fn().mockResolvedValue(undefined),
      provisionDependencies: vi.fn().mockResolvedValue(undefined),
    }

    return { client, mockLoopHandler, mockSandboxManager, resolveSelect, rejectSelect, selectPromise }
  }

  test('onStarted fires only after selectSessionBestEffort resolves', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-ordering-resolve-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

    const mocks = buildOrderingMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp',
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client: mocks.client,
      pendingTeardowns: mockPendingTeardowns,
    })

    let onStartedTs: number | null = null
    const resultPromise = service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline' as const, planText: '# Order Plan\n\nTest ordering.' },
        
        lifecycle: {
          selectSession: true,
          onStarted: (info) => { onStartedTs = Date.now() },
        },
      },
    )

    // Allow session creation to proceed but don't resolve selectSession yet
    await new Promise(r => setTimeout(r, 100))

    // At this point, with the fix in place, onStarted should NOT have fired yet
    // because selectSession hasn't resolved
    const beforeResolveTs = Date.now()

    // Now resolve the deferred selectSession
    mocks.resolveSelect!()
    const selectResolvedTs = Date.now()

    await resultPromise

    expect(onStartedTs).not.toBeNull()
    expect(onStartedTs!).toBeGreaterThanOrEqual(selectResolvedTs - 5)

    db.close()
  })

  test('onStarted still fires if selectSession rejects', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-ordering-reject-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

    const mocks = buildOrderingMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp',
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client: mocks.client,
      pendingTeardowns: mockPendingTeardowns,
    })

    let onStartedCalled = false
    const resultPromise = service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline' as const, planText: '# Reject Plan\n\nTest rejection.' },
        
        lifecycle: {
          selectSession: true,
          onStarted: () => { onStartedCalled = true },
        },
      },
    )

    // Wait a bit then reject the selectSession promise
    await new Promise(r => setTimeout(r, 50))
    mocks.rejectSelect!(new Error('TUI connection lost'))
    
    const result = await resultPromise

    expect(result.ok).toBe(true)
    expect(onStartedCalled).toBe(true)

    db.close()
  })

  test('onStarted fires after a bounded timeout if selectSession hangs', async () => {
    // Shorten the select timeout for this test to keep it fast
    const prevEnv = process.env.FORGE_SELECT_TIMEOUT_MS
    process.env.FORGE_SELECT_TIMEOUT_MS = '50'
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-ordering-timeout-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

    const mocks = buildOrderingMocks()
    const { createForgeExecutionService } = await import('../../src/services/execution')
    const service = createForgeExecutionService({
      projectId: PROJECT_ID, directory: '/tmp/test',
      config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
      logger: mockLogger, dataDir: '/tmp',
      plansRepo, loopsRepo, loop: loopService as any, loopHandler: mocks.mockLoopHandler as any,
      sectionPlansRepo, sandboxManager: mocks.mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client: mocks.client,
      pendingTeardowns: mockPendingTeardowns,
    })

    let onStartedCalled = false
    const resultPromise = service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline' as const, planText: '# Timeout Plan\n\nTest timeout.' },
        
        lifecycle: {
          selectSession: true,
          onStarted: () => { onStartedCalled = true },
        },
      },
    )

    // The selectSession mock never resolves — it hangs forever.
    // After the fix, a bounded timeout will kick in (SELECT_TIMEOUT_MS).
    // We wait long enough to see if onStarted fires within that window.
    const elapsed = Date.now()
    const result = await resultPromise
    const totalElapsed = Date.now() - elapsed

    expect(result.ok).toBe(true)
    expect(onStartedCalled).toBe(true)

    // Should have completed reasonably quickly (within timeout budget + some margin)
    expect(totalElapsed).toBeLessThan(5000)

    db.close()
    if (prevEnv === undefined) delete process.env.FORGE_SELECT_TIMEOUT_MS
    else process.env.FORGE_SELECT_TIMEOUT_MS = prevEnv
  })
})

describe('handleStartLoop selectSessionBestEffort retry on connection errors', () => {
  const noopFn = () => {}
  const PROJECT_ID = 'test-project'

  test('retries selectSession on connection kind errors, loop starts successfully without publish fallback', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-conn-retry-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

    let selectCallCount = 0
    let publishCalled = false

    // selectSessionBestEffort is called at two call sites during handleStartLoop
    // (doSelectInitialWorktreeSession and attachLoopToSession). Each calls
    // selectSession up to 3 times. Our mock fails the first 2 attempts of each
    // group of 3 (count % 3 != 0) and succeeds on the 3rd (count % 3 == 0).
    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test',
          directory: '/tmp/wt/abc',
          branch: 'opencode/abc',
        }),
      },
      tui: {
        selectSession: async () => {
          selectCallCount++
          if (selectCallCount % 3 !== 0) {
            throw new ForgeClientError({
              kind: 'connection',
              method: 'tui.selectSession',
              message: 'fetch failed',
            })
          }
        },
        publish: async () => {
          publishCalled = true
        },
      },
    })

    const mockLoopHandler = {
      runExclusive: async <T>(_name: string, fn: () => Promise<T>) => fn(),
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
      isLiveByName: vi.fn().mockResolvedValue(false),
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
      loop: loopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nRetry on connection errors.' },
        lifecycle: { selectSession: true },
      },
    )

    // The loop should start successfully despite connection retries
    expect(result.ok).toBe(true)

    // The first selectSessionBestEffort call (blocking, in doSelectInitialWorktreeSession)
    // tries 3 times: 2 connection failures then success. The second call
    // (fire-and-forget, in attachLoopToSession) may only make 1 attempt before
    // the test checks counts. Verify at least the blocking group's 3 calls happened.
    expect(selectCallCount).toBeGreaterThanOrEqual(3)

    // publish should NOT have been called because the blocking group's 3rd
    // attempt succeeded (fire-and-forget group hasn't exhausted retries yet)
    expect(publishCalled).toBe(false)

    db.close()
  })

  test('exhausts all retries then falls back to publish when selectSession always throws connection', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'exec-conn-exhaust-'))
    const db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger, undefined, undefined, sectionPlansRepo)

    let selectCallCount = 0
    let publishCallCount = 0

    const { client } = createFakeForgeClient({
      workspace: {
        create: async () => ({
          id: 'ws_test',
          directory: '/tmp/wt/abc',
          branch: 'opencode/abc',
        }),
      },
      tui: {
        selectSession: async () => {
          selectCallCount++
          throw new ForgeClientError({
            kind: 'connection',
            method: 'tui.selectSession',
            message: 'persistent fetch failed',
          })
        },
        publish: async () => {
          publishCallCount++
        },
      },
    })

    const mockLoopHandler = {
      runExclusive: async <T>(_name: string, fn: () => Promise<T>) => fn(),
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
      isLiveByName: vi.fn().mockResolvedValue(false),
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
      loop: loopService as any,
      loopHandler: mockLoopHandler as any,
      sectionPlansRepo,
      sandboxManager: mockSandboxManager as any,
      workspaceStatusRegistry: mockWorkspaceStatusRegistry,
      client,
      pendingTeardowns: mockPendingTeardowns,
    })

    const result = await service.dispatch(
      { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        type: 'loop.start' as const,
        source: { kind: 'inline', planText: '# Test Plan\n\nExhaust connection retries.' },
        lifecycle: { selectSession: true },
      },
    )

    // The loop should still start successfully (select is best-effort, not fatal)
    expect(result.ok).toBe(true)

    // The first selectSessionBestEffort call (blocking, in doSelectInitialWorktreeSession)
    // tries 3 times (all fail). The second call (fire-and-forget, in
    // attachLoopToSession) may only make 1 attempt before the test checks
    // counts. Verify at least the blocking group's 3 calls happened.
    expect(selectCallCount).toBeGreaterThanOrEqual(3)

    // publish should have been called at least from the blocking group's fallback
    expect(publishCallCount).toBeGreaterThanOrEqual(1)

    db.close()
  })
})
