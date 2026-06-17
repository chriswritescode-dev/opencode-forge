import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import type { DockerService } from '../../src/sandbox/docker'
import type { Logger } from '../../src/types'

describe('SandboxManager caching', () => {
  let mockDocker: Partial<DockerService>
  let mockLogger: Partial<Logger>

  beforeEach(() => {
    vi.useFakeTimers()
    mockDocker = {
      checkDocker: vi.fn(async () => true),
      imageExists: vi.fn(async () => true),
      containerName: (worktreeName: string) => `forge-${worktreeName}`,
      isRunning: vi.fn(async () => false),
      createContainer: vi.fn(async () => {}),
      removeContainer: vi.fn(async () => {}),
      listContainersByPrefix: vi.fn(async () => []),
    }
    mockLogger = {
      log: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should cache checkDocker and latch imageExists across two start() calls', async () => {
    const firstIsRunning = vi.fn(async () => false)
    const secondIsRunning = vi.fn(async () => true)
    mockDocker.isRunning = vi.fn()
      .mockImplementationOnce(firstIsRunning)
      .mockImplementationOnce(secondIsRunning)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    await manager.start('test-wt', '/tmp/project')

    await manager.start('test-wt', '/tmp/project')

    expect(mockDocker.checkDocker).toHaveBeenCalledTimes(1)
    expect(mockDocker.imageExists).toHaveBeenCalledTimes(1)
  })

  it('should reject both calls when Docker is unavailable and cache negative result within TTL', async () => {
    mockDocker.checkDocker = vi.fn(async () => false)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('Docker is not available')
    expect(mockDocker.checkDocker).toHaveBeenCalledTimes(1)

    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('Docker is not available')
    expect(mockDocker.checkDocker).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_000)
    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('Docker is not available')
    expect(mockDocker.checkDocker).toHaveBeenCalledTimes(2)
  })

  it('should not call checkDocker or imageExists when restore delegates to start and cache is warm', async () => {
    mockDocker.isRunning = vi.fn(async () => false)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    await manager.start('test-wt', '/tmp/project')
    expect(mockDocker.checkDocker).toHaveBeenCalledTimes(1)
    expect(mockDocker.imageExists).toHaveBeenCalledTimes(1)

    mockDocker.isRunning = vi.fn(async () => false)
    await manager.restore('other-wt', '/tmp/project', new Date().toISOString())

    expect(mockDocker.checkDocker).toHaveBeenCalledTimes(1)
    expect(mockDocker.imageExists).toHaveBeenCalledTimes(1)
  })
})
