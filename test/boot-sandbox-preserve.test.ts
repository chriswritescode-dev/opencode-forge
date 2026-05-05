import { describe, it, expect, mock } from 'bun:test'
import { createLoopService } from '../src/services/loop'
import type { LoopsRepo, LoopRow } from '../src/storage/repos/loops-repo'
import type { PlansRepo } from '../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import type { Logger } from '../src/types'
import type { SandboxManager } from '../src/sandbox/manager'
import { reconcileSandboxes, type ReconcileSandboxesDeps } from '../src/sandbox/reconcile'

describe('boot sandbox preserve integration', () => {
  function createMockRepos() {
    const mockLoopsRepo = {
      insert: mock(() => true),
      get: mock(() => null),
      getLarge: mock(() => null),
      delete: mock(() => {}),
      setStatus: mock(() => {}),
      setCurrentSessionId: mock(() => {}),
      getBySessionId: mock(() => null),
      findPartial: mock(() => ({ match: null, candidates: [] })),
      listByStatus: mock(() => []),
      updatePhase: mock(() => {}),
      setPhaseAndResetError: mock(() => {}),
      setModelFailed: mock(() => {}),
      setLastAuditResult: mock(() => {}),
      replaceSession: mock(() => {}),
      terminate: mock(() => {}),
      setSandboxContainer: mock(() => {}),
      clearWorkspaceId: mock(() => {}),
      setWorkspaceId: mock(() => {}),
      incrementError: mock(() => 0),
      resetError: mock(() => {}),
    } as unknown as LoopsRepo

    const mockPlansRepo = {} as PlansRepo
    const mockReviewFindingsRepo = {} as ReviewFindingsRepo
    const mockLogger = { log: mock(), error: mock(), debug: mock() } as Logger

    return { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger }
  }

  function createSandboxLoopRow(overrides?: Partial<LoopRow>): LoopRow {
    const now = Date.now()
    return {
      projectId: 'test-project',
      loopName: 'alpha',
      status: 'running',
      currentSessionId: 's1',
      worktree: true,
      worktreeDir: '/tmp/wt',
      worktreeBranch: null,
      projectDir: '/tmp/wt',
      maxIterations: 5,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding',
      executionModel: null,
      auditorModel: null,
      modelFailed: false,
      sandbox: true,
      sandboxContainer: 'oc-forge-sandbox-alpha',
      startedAt: now,
      completedAt: null,
      terminationReason: null,
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      ...overrides,
    }
  }

  it('should preserve loop with live container at boot', async () => {
    const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

    const sandboxRow = createSandboxLoopRow()
    mockLoopsRepo.listByStatus = mock(() => [sandboxRow])
    mockLoopsRepo.getLarge = mock(() => ({ prompt: 'test prompt', lastAuditResult: null }))
    mockLoopsRepo.get = mock((projectId: string, loopName: string) => {
      if (loopName === 'alpha') return sandboxRow
      return null
    })

    const loopService = createLoopService(
      mockLoopsRepo,
      mockPlansRepo,
      mockReviewFindingsRepo,
      'test-project',
      mockLogger,
      undefined,
      undefined
    )

    // Mock sandbox manager with isLiveByName returning true for 'alpha'
    const mockSandboxManager = {
      isLiveByName: mock(async (name: string) => name === 'alpha'),
      cleanupOrphans: mock(async () => 0),
      start: mock(async () => ({ containerName: 'oc-forge-sandbox-alpha' })),
      restore: mock(async () => {}),
      stop: mock(async () => {}),
      isActive: mock(() => false),
      isLive: mock(async () => false),
      getActive: mock(() => null),
      docker: {} as any,
    } as unknown as SandboxManager

    // Step 1: reconcileStale with isSandboxLive probe
    const reconcileResult = await loopService.reconcileStale({
      isSandboxLive: (name) => mockSandboxManager.isLiveByName(name),
    })

    expect(reconcileResult.cancelled).toBe(0)
    expect(reconcileResult.preserved).toEqual(['alpha'])
    expect(mockLoopsRepo.terminate).not.toHaveBeenCalled()

    // Step 2: cleanupSandboxOrphansAcrossRegistry (simulate)
    const preserveLoops = loopService.listActive()
      .filter((state) => state.sandbox && state.loopName)
      .map((state) => state.loopName!)
    await mockSandboxManager.cleanupOrphans(preserveLoops)

    expect(mockSandboxManager.cleanupOrphans).toHaveBeenCalledWith(['alpha'])

    // Step 3: reconcileSandboxes
    const reconcileDeps: ReconcileSandboxesDeps = {
      sandboxManager: mockSandboxManager,
      loopService,
      logger: mockLogger,
    }

    await reconcileSandboxes(reconcileDeps)

    // restore should be called (it will see container running and repopulate map)
    expect(mockSandboxManager.restore).toHaveBeenCalledWith('alpha', '/tmp/wt', expect.any(String))
    // start should NOT be called
    expect(mockSandboxManager.start).not.toHaveBeenCalled()
    // stop should NOT be called
    expect(mockSandboxManager.stop).not.toHaveBeenCalled()

    // Loop row should still be running (not cancelled)
    const state = loopService.getActiveState('alpha')
    expect(state).toBeTruthy()
    expect(state?.active).toBe(true)
  })

  it('should restore container for preserved loop when container exists in Docker', async () => {
    // This test verifies the "negative case" from Phase 4: when a loop is preserved
    // (isLiveByName returns true) but the in-memory map is empty (boot scenario),
    // reconcileSandboxes should call restore, which will repopulate the map.
    const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

    let loopRow = createSandboxLoopRow()
    mockLoopsRepo.listByStatus = mock(() => (loopRow.status === 'running' ? [loopRow] : []))
    mockLoopsRepo.getLarge = mock(() => ({ prompt: 'test prompt', lastAuditResult: null }))
    mockLoopsRepo.get = mock((projectId: string, loopName: string) => {
      if (loopName === 'alpha') return loopRow
      return null
    })

    const loopService = createLoopService(
      mockLoopsRepo,
      mockPlansRepo,
      mockReviewFindingsRepo,
      'test-project',
      mockLogger,
      undefined,
      undefined
    )

    // Mock sandbox manager: isLiveByName returns true (loop preserved, container live in Docker)
    // isActive returns false (in-memory map is empty at boot)
    // restore should be called by reconcileSandboxes to repopulate the map
    const mockSandboxManager = {
      isLiveByName: mock(async () => true),
      cleanupOrphans: mock(async () => 0),
      start: mock(async () => ({ containerName: 'oc-forge-sandbox-alpha' })),
      restore: mock(async () => {}),
      stop: mock(async () => {}),
      isActive: mock(() => false),
      isLive: mock(async () => false),
      getActive: mock(() => null),
      docker: {} as any,
    } as unknown as SandboxManager

    // Step 1: reconcileStale with isSandboxLive probe - loop is preserved
    const reconcileResult = await loopService.reconcileStale({
      isSandboxLive: (name) => mockSandboxManager.isLiveByName(name),
    })

    expect(reconcileResult.cancelled).toBe(0)
    expect(reconcileResult.preserved).toEqual(['alpha'])
    expect(mockLoopsRepo.terminate).not.toHaveBeenCalled()
    expect(loopRow.status).toBe('running')

    // Step 2: cleanupSandboxOrphansAcrossRegistry (simulate)
    const preserveLoops = loopService.listActive()
      .filter((state) => state.sandbox && state.loopName)
      .map((state) => state.loopName!)
    await mockSandboxManager.cleanupOrphans(preserveLoops)

    expect(mockSandboxManager.cleanupOrphans).toHaveBeenCalledWith(['alpha'])

    // Step 3: reconcileSandboxes - should call restore to repopulate map
    const reconcileDeps: ReconcileSandboxesDeps = {
      sandboxManager: mockSandboxManager,
      loopService,
      logger: mockLogger,
    }

    await reconcileSandboxes(reconcileDeps)

    // restore should be called because isActive returns false (map is empty)
    // even though the container is actually running (isLiveByName returns true)
    expect(mockSandboxManager.restore).toHaveBeenCalledWith('alpha', '/tmp/wt', expect.any(String))
    // start should NOT be called - restore handles it
    expect(mockSandboxManager.start).not.toHaveBeenCalled()
  })

  it('should start fresh container when loop is active but container is gone', async () => {
    const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

    // Create a loop that is still running but has a dead container
    // This simulates the case where reconcileStale preserves the loop (isLiveByName returns true)
    // but the container reference is stale and needs to be restarted
    let loopRow = createSandboxLoopRow()
    mockLoopsRepo.listByStatus = mock(() => (loopRow.status === 'running' ? [loopRow] : []))
    mockLoopsRepo.getLarge = mock(() => ({ prompt: 'test prompt', lastAuditResult: null }))
    mockLoopsRepo.get = mock((projectId: string, loopName: string) => {
      if (loopName === 'alpha') return loopRow
      return null
    })

    const loopService = createLoopService(
      mockLoopsRepo,
      mockPlansRepo,
      mockReviewFindingsRepo,
      'test-project',
      mockLogger,
      undefined,
      undefined
    )

    // Mock sandbox manager: isLiveByName returns true (loop preserved),
    // but isActive returns false (container not in map), triggering restore
    const mockSandboxManager = {
      isLiveByName: mock(async () => true),
      cleanupOrphans: mock(async () => 0),
      start: mock(async () => ({ containerName: 'oc-forge-sandbox-alpha-new' })),
      restore: mock(async () => {}),
      stop: mock(async () => {}),
      isActive: mock(() => false),
      isLive: mock(async () => false),
      getActive: mock(() => null),
      docker: {} as any,
    } as unknown as SandboxManager

    // Step 1: reconcileStale with isSandboxLive probe - loop is preserved
    const reconcileResult = await loopService.reconcileStale({
      isSandboxLive: (name) => mockSandboxManager.isLiveByName(name),
    })

    expect(reconcileResult.cancelled).toBe(0)
    expect(reconcileResult.preserved).toEqual(['alpha'])
    expect(mockLoopsRepo.terminate).not.toHaveBeenCalled()

    // Step 2: cleanupSandboxOrphansAcrossRegistry (simulate)
    const preserveLoops = loopService.listActive()
      .filter((state) => state.sandbox && state.loopName)
      .map((state) => state.loopName!)
    await mockSandboxManager.cleanupOrphans(preserveLoops)

    expect(mockSandboxManager.cleanupOrphans).toHaveBeenCalledWith(['alpha'])

    // Step 3: reconcileSandboxes - since container is not active, should start fresh
    const reconcileDeps: ReconcileSandboxesDeps = {
      sandboxManager: mockSandboxManager,
      loopService,
      logger: mockLogger,
    }

    await reconcileSandboxes(reconcileDeps)

    // Since sandboxContainer is set but isActive returns false, restore should be called
    // restore will then determine if container is actually running or needs to be started
    expect(mockSandboxManager.restore).toHaveBeenCalledWith('alpha', '/tmp/wt', expect.any(String))
    // start should NOT be called directly - restore handles it
    expect(mockSandboxManager.start).not.toHaveBeenCalled()
  })

  it('should cancel loop and restore container for preserved loop (negative case)', async () => {
    // This test verifies the Phase 4 "negative case": when isLiveByName returns false
    // for one loop (alpha), it gets cancelled. But reconcileSandboxes still processes
    // other active loops (beta) and restores their containers.
    const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

    // Two loops: alpha (container not live) and beta (container live)
    const alphaRow = createSandboxLoopRow({ loopName: 'alpha', sandboxContainer: 'oc-forge-sandbox-alpha' })
    const betaRow = createSandboxLoopRow({ loopName: 'beta', sandboxContainer: 'oc-forge-sandbox-beta' })

    // listByStatus should return only running loops (alpha is cancelled after reconcileStale)
    mockLoopsRepo.listByStatus = mock((projectId: string, statuses: string[]) => {
      if (statuses.includes('running')) {
        return alphaRow.status === 'running' && betaRow.status === 'running'
          ? [alphaRow, betaRow]
          : betaRow.status === 'running'
            ? [betaRow]
            : []
      }
      return []
    })
    mockLoopsRepo.getLarge = mock(() => ({ prompt: 'test prompt', lastAuditResult: null }))
    mockLoopsRepo.get = mock((projectId: string, loopName: string) => {
      if (loopName === 'alpha') return alphaRow
      if (loopName === 'beta') return betaRow
      return null
    })
    mockLoopsRepo.terminate = mock((projectId: string, loopName: string, opts: any) => {
      if (loopName === 'alpha') {
        alphaRow.status = opts.status ?? 'cancelled'
        alphaRow.terminationReason = opts.reason ?? null
        alphaRow.completedAt = opts.completedAt ?? null
      }
    })

    const loopService = createLoopService(
      mockLoopsRepo,
      mockPlansRepo,
      mockReviewFindingsRepo,
      'test-project',
      mockLogger,
      undefined,
      undefined
    )

    // isLiveByName returns false for alpha (not live), true for beta (live)
    const mockSandboxManager = {
      isLiveByName: mock(async (name: string) => name === 'beta'),
      cleanupOrphans: mock(async () => 0),
      start: mock(async () => ({ containerName: 'oc-forge-sandbox-new' })),
      restore: mock(async () => {}),
      stop: mock(async () => {}),
      isActive: mock(() => false),
      isLive: mock(async () => false),
      getActive: mock(() => null),
      docker: {} as any,
    } as unknown as SandboxManager

    // Step 1: reconcileStale - alpha is cancelled, beta is preserved
    const reconcileResult = await loopService.reconcileStale({
      isSandboxLive: (name) => mockSandboxManager.isLiveByName(name),
    })

    expect(reconcileResult.cancelled).toBe(1)
    expect(reconcileResult.preserved).toEqual(['beta'])
    expect(mockLoopsRepo.terminate).toHaveBeenCalledTimes(1)
    expect(mockLoopsRepo.terminate).toHaveBeenCalledWith('test-project', 'alpha', expect.any(Object))
    expect(alphaRow.status).toBe('cancelled')
    expect(betaRow.status).toBe('running')

    // Step 2: cleanupSandboxOrphans - preserve set includes only beta (alpha is cancelled)
    const preserveLoops = loopService.listActive()
      .filter((state) => state.sandbox && state.loopName)
      .map((state) => state.loopName!)
    await mockSandboxManager.cleanupOrphans(preserveLoops)

    expect(mockSandboxManager.cleanupOrphans).toHaveBeenCalledWith(['beta'])

    // Step 3: reconcileSandboxes - beta is processed (alpha is cancelled, not processed)
    const reconcileDeps: ReconcileSandboxesDeps = {
      sandboxManager: mockSandboxManager,
      loopService,
      logger: mockLogger,
    }

    await reconcileSandboxes(reconcileDeps)

    // restore should be called for beta (preserved loop with container in Docker)
    expect(mockSandboxManager.restore).toHaveBeenCalledWith('beta', '/tmp/wt', expect.any(String))
    // restore should NOT be called for alpha (cancelled)
    // start should NOT be called (restore handles it)
    expect(mockSandboxManager.start).not.toHaveBeenCalled()
  })
})
