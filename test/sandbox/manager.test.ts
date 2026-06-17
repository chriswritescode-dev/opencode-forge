import { describe, it, expect, vi } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import type { DockerService } from '../../src/sandbox/docker'
import type { Logger } from '../../src/types'

describe('SandboxManager.isLiveByName', () => {
  function createMockDocker(): Partial<DockerService> {
    return {
      checkDocker: vi.fn(async () => true),
      imageExists: vi.fn(async () => true),
      containerName: (worktreeName: string) => `forge-${worktreeName}`,
      isRunning: vi.fn(async () => false),
      createContainer: vi.fn(async () => {}),
      removeContainer: vi.fn(async () => {}),
      listContainersByPrefix: vi.fn(async () => []),
    }
  }

  function createMockLogger(): Partial<Logger> {
    return {
      log: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }
  }

  it('should return true when Docker reports container is running', async () => {
    const mockDocker = createMockDocker()
    mockDocker.isRunning = vi.fn(async () => true)
    const mockLogger = createMockLogger()

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    const result = await manager.isLiveByName('test-worktree')

    expect(result).toBe(true)
    expect(mockDocker.isRunning).toHaveBeenCalledWith('forge-test-worktree')
  })

  it('should return false when Docker reports container is not running', async () => {
    const mockDocker = createMockDocker()
    mockDocker.isRunning = vi.fn(async () => false)
    const mockLogger = createMockLogger()

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    const result = await manager.isLiveByName('test-worktree')

    expect(result).toBe(false)
    expect(mockDocker.isRunning).toHaveBeenCalledWith('forge-test-worktree')
  })

  it('should not modify activeSandboxes map', async () => {
    const mockDocker = createMockDocker()
    mockDocker.isRunning = vi.fn(async () => true)
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
