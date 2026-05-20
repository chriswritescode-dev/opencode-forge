import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { reconcileSandboxes, type ReconcileSandboxesDeps } from '../../src/sandbox/reconcile'
import type { SandboxManager } from '../../src/sandbox/manager'
import type { LoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { LoopRow } from '../../src/storage'
import { loopRegistry } from '../../src/utils/loop-registry'

describe('reconcileSandboxes', () => {
  let mockSandboxManager: Partial<SandboxManager>
  let mockLoopService: Partial<LoopService>
  let mockLogger: Partial<Logger>
  let deps: ReconcileSandboxesDeps

  beforeEach(() => {
    // Clear registry before each test to avoid cross-test contamination
    loopRegistry.clear()

    mockSandboxManager = {
      isActive: mock(),
      isLive: mock(async () => true),
      getActive: mock(),
      start: mock(),
      restore: mock(),
      stop: mock(),
      cleanupOrphans: mock(),
    }

    mockLoopService = {
      listActive: mock(),
      setSandboxContainer: mock(),
      getActiveState: mock(),
    }

    mockLogger = {
      log: mock(),
      error: mock(),
      debug: mock(),
    }

    deps = {
      sandboxManager: mockSandboxManager as SandboxManager,
      loop: mockLoopService as unknown as import('../../src/loop').Loop,
      logger: mockLogger as Logger,
    }
  })

  function createBaseState(overrides?: Partial<LoopRow>): LoopRow {
    return {
      projectId: 'test-project',
      loopName: 'test-loop',
      status: 'running',
      currentSessionId: 'test-session',
      worktreeDir: '/test/dir',
      projectDir: '/test/dir',
      iteration: 1,
      maxIterations: 0,
      startedAt: Date.now(),
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      sandbox: true,
      worktree: true,
      worktreeBranch: null,

      completionSummary: null,
      workspaceId: null,
      executionModel: null,
      auditorModel: null,
      modelFailed: false,
      sandboxContainer: null,
      completedAt: null,
      terminationReason: null,
      ...overrides,
    }
  }

  it('should not call start when container is already active', async () => {
    const state = createBaseState({ sandboxContainer: 'forge-test-loop' })

    loopRegistry.add('test-loop')
    mockLoopService.listActive.mockReturnValue([state])
    mockSandboxManager.isActive.mockReturnValue(true)
    mockSandboxManager.isLive.mockResolvedValue(true)
    mockSandboxManager.getActive.mockReturnValue({
      containerName: 'forge-test-loop',
      projectDir: '/test/dir',
      startedAt: state.startedAt,
    })

    await reconcileSandboxes(deps)

    expect(mockSandboxManager.start).not.toHaveBeenCalled()
    expect(mockSandboxManager.restore).not.toHaveBeenCalled()
    expect(mockLoopService.setSandboxContainer).not.toHaveBeenCalled()
  })

  it('should backfill sandboxContainer when container is active but name is missing', async () => {
    const state = createBaseState({ sandboxContainer: null })

    loopRegistry.add('test-loop')
    mockLoopService.listActive.mockReturnValue([state])
    mockSandboxManager.isActive.mockReturnValue(true)
    mockSandboxManager.isLive.mockResolvedValue(true)
    mockSandboxManager.getActive.mockReturnValue({
      containerName: 'forge-test-loop',
      projectDir: '/test/dir',
      startedAt: state.startedAt,
    })

    await reconcileSandboxes(deps)

    expect(mockSandboxManager.start).not.toHaveBeenCalled()
    expect(mockLoopService.setSandboxContainer).toHaveBeenCalledWith('test-loop', 'forge-test-loop')
  })

  it('should call restore when container name exists but container is not active', async () => {
    const state = createBaseState({ sandboxContainer: 'forge-test-loop' })

    loopRegistry.add('test-loop')
    mockLoopService.listActive.mockReturnValue([state])
    mockSandboxManager.isActive.mockReturnValue(false)

    await reconcileSandboxes(deps)

    expect(mockSandboxManager.start).not.toHaveBeenCalled()
    expect(mockSandboxManager.restore).toHaveBeenCalledWith('test-loop', '/test/dir', state.startedAt)
  })

  it('should call start when no container name exists', async () => {
    const state = createBaseState({ sandboxContainer: null })

    loopRegistry.add('test-loop')
    mockLoopService.listActive.mockReturnValue([state])
    mockLoopService.getActiveState.mockReturnValue(state)
    mockSandboxManager.isActive.mockReturnValue(false)
    mockSandboxManager.start.mockResolvedValue({ containerName: 'forge-test-loop' })

    await reconcileSandboxes(deps)

    expect(mockSandboxManager.start).toHaveBeenCalledWith('test-loop', '/test/dir', state.startedAt)
    expect(mockLoopService.setSandboxContainer).toHaveBeenCalledWith('test-loop', 'forge-test-loop')
  })

  it('should skip loops without sandbox enabled', async () => {
    const state = createBaseState({ sandbox: false })

    loopRegistry.add('test-loop')
    mockLoopService.listActive.mockReturnValue([state])

    await reconcileSandboxes(deps)

    expect(mockSandboxManager.start).not.toHaveBeenCalled()
    expect(mockSandboxManager.restore).not.toHaveBeenCalled()
    expect(mockSandboxManager.isActive).not.toHaveBeenCalled()
  })

  it('should skip loops without worktreeDir', async () => {
    const state = createBaseState({ worktreeDir: '' })

    loopRegistry.add('test-loop')
    mockLoopService.listActive.mockReturnValue([state])

    await reconcileSandboxes(deps)

    expect(mockSandboxManager.start).not.toHaveBeenCalled()
    expect(mockSandboxManager.restore).not.toHaveBeenCalled()
  })

  it('should correct stale sandboxContainer when it differs from manager value', async () => {
    const state = createBaseState({ sandboxContainer: 'forge-stale-name' })

    loopRegistry.add('test-loop')
    mockLoopService.listActive.mockReturnValue([state])
    mockLoopService.getActiveState.mockReturnValue(state)
    mockSandboxManager.isActive.mockReturnValue(true)
    mockSandboxManager.isLive.mockResolvedValue(true)
    mockSandboxManager.getActive.mockReturnValue({
      containerName: 'forge-test-loop',
      projectDir: '/test/dir',
      startedAt: state.startedAt,
    })

    await reconcileSandboxes(deps)

    expect(mockSandboxManager.start).not.toHaveBeenCalled()
    expect(mockLoopService.setSandboxContainer).toHaveBeenCalledWith('test-loop', 'forge-test-loop')
  })

  it('should not set state when container is active and name already matches', async () => {
    const state = createBaseState({ sandboxContainer: 'forge-test-loop' })

    loopRegistry.add('test-loop')
    mockLoopService.listActive.mockReturnValue([state])
    mockSandboxManager.isActive.mockReturnValue(true)
    mockSandboxManager.getActive.mockReturnValue({
      containerName: 'forge-test-loop',
      projectDir: '/test/dir',
      startedAt: state.startedAt,
    })

    await reconcileSandboxes(deps)

    expect(mockLoopService.setSandboxContainer).not.toHaveBeenCalled()
  })

  it('should continue processing other loops when one fails', async () => {
    const state1 = createBaseState({ loopName: 'test-loop-1' })
    const state2 = createBaseState({ loopName: 'test-loop-2' })

    loopRegistry.add('test-loop-1')
    loopRegistry.add('test-loop-2')
    mockLoopService.listActive.mockReturnValue([state1, state2])
    mockLoopService.getActiveState.mockImplementation((loopName) => {
      if (loopName === 'test-loop-1') return state1
      if (loopName === 'test-loop-2') return state2
      return null
    })
    mockSandboxManager.isActive.mockReturnValue(false)
    mockSandboxManager.start.mockImplementation(async (loopName) => {
      if (loopName === 'test-loop-1') {
        throw new Error('Failed to start container')
      }
      return { containerName: 'forge-test-loop-2' }
    })

    await reconcileSandboxes(deps)

    // First loop failed, but second should still be processed
    expect(mockSandboxManager.start).toHaveBeenCalledTimes(2)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('test-loop-1'),
      expect.any(Error)
    )
    expect(mockLoopService.setSandboxContainer).toHaveBeenCalledWith('test-loop-2', 'forge-test-loop-2')
  })

  it('should prevent concurrent execution (re-entrancy guard)', async () => {
    const state = createBaseState()
    
    loopRegistry.add('test-loop')
    mockLoopService.listActive.mockReturnValue([state])
    
    // Track when isActive is called
    let isActiveCallCount = 0
    mockSandboxManager.isActive.mockImplementation(() => {
      isActiveCallCount++
      return false
    })
    mockSandboxManager.start.mockImplementation(async () => {
      // Simulate slow start
      await new Promise(resolve => setTimeout(resolve, 50))
      return { containerName: 'forge-test-loop' }
    })

    // Start two concurrent reconciliations at the same time
    const promise1 = reconcileSandboxes(deps)
    const promise2 = reconcileSandboxes(deps)

    await Promise.all([promise1, promise2])

    // Due to re-entrancy guard, only the first call should execute the full reconciliation
    // The second call should return early before calling listActive
    expect(mockLoopService.listActive).toHaveBeenCalledTimes(1)
    expect(mockSandboxManager.start).toHaveBeenCalledTimes(1)
  })

  it('should restore container when map is stale but Docker reports container missing', async () => {
    const state = createBaseState({ sandboxContainer: 'forge-test-loop' })
    
    loopRegistry.add('test-loop')
    mockLoopService.listActive.mockReturnValue([state])
    // Map says active, but isLive will check Docker
    mockSandboxManager.isActive.mockReturnValue(true)
    mockSandboxManager.getActive.mockReturnValue({
      containerName: 'forge-test-loop',
      projectDir: '/test/dir',
      startedAt: state.startedAt,
    })
    // Simulate isLive checking Docker and finding container not running
    const mockManagerWithIsLive = {
      ...mockSandboxManager,
      isLive: mock(async () => {
        // Container not in Docker - stale map entry
        return false
      }),
    }
    const depsWithIsLive = {
      ...deps,
      sandboxManager: mockManagerWithIsLive as unknown as SandboxManager,
    }
    
    await reconcileSandboxes(depsWithIsLive)
    
    // Should have called restore since Docker says container is not running
    expect(mockSandboxManager.restore).toHaveBeenCalledWith('test-loop', '/test/dir', state.startedAt)
  })
})
