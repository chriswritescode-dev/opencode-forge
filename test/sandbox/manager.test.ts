import { describe, it, expect, mock } from 'bun:test'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import type { DockerService } from '../../src/sandbox/docker'
import type { Logger } from '../../src/types'

describe('SandboxManager.isLiveByName', () => {
  function createMockDocker(): Partial<DockerService> {
    return {
      checkDocker: mock(async () => true),
      imageExists: mock(async () => true),
      containerName: (worktreeName: string) => `oc-forge-sandbox-${worktreeName}`,
      isRunning: mock(async () => false),
      createContainer: mock(async () => {}),
      removeContainer: mock(async () => {}),
      listContainersByPrefix: mock(async () => []),
    }
  }

  function createMockLogger(): Partial<Logger> {
    return {
      log: mock(),
      error: mock(),
      debug: mock(),
    }
  }

  it('should return true when Docker reports container is running', async () => {
    const mockDocker = createMockDocker()
    mockDocker.isRunning = mock(async () => true)
    const mockLogger = createMockLogger()

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    const result = await manager.isLiveByName('test-worktree')

    expect(result).toBe(true)
    expect(mockDocker.isRunning).toHaveBeenCalledWith('oc-forge-sandbox-test-worktree')
  })

  it('should return false when Docker reports container is not running', async () => {
    const mockDocker = createMockDocker()
    mockDocker.isRunning = mock(async () => false)
    const mockLogger = createMockLogger()

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    const result = await manager.isLiveByName('test-worktree')

    expect(result).toBe(false)
    expect(mockDocker.isRunning).toHaveBeenCalledWith('oc-forge-sandbox-test-worktree')
  })

  it('should not modify activeSandboxes map', async () => {
    const mockDocker = createMockDocker()
    mockDocker.isRunning = mock(async () => true)
    const mockLogger = createMockLogger()

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    // Map should be empty initially
    expect(manager.isActive('test-worktree')).toBe(false)

    await manager.isLiveByName('test-worktree')

    // Map should still be empty - isLiveByName doesn't modify it
    expect(manager.isActive('test-worktree')).toBe(false)
  })
})
