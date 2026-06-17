import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import type { DockerService } from '../../src/sandbox/docker'
import type { Logger } from '../../src/types'

describe('SandboxManager.ensureRunning', () => {
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

  it('creates a new container when no active sandbox exists', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    expect(mockDocker.createContainer).toHaveBeenCalledTimes(1)
  })

  it('reuses a running container without calling start', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    // First call creates
    mockDocker.isRunning = vi.fn(async () => false)
    await manager.ensureRunning('test-wt', '/tmp/project')
    const createCountAfterFirst = (mockDocker.createContainer as ReturnType<typeof vi.fn>).mock.calls.length

    // Second call: container is now in map and Docker reports it running
    mockDocker.isRunning = vi.fn(async () => true)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // createContainer should not have been called again
    expect(mockDocker.createContainer).toHaveBeenCalledTimes(createCountAfterFirst)
  })

  it('skips isRunning when called within 2s TTL', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    // First call creates the container
    mockDocker.isRunning = vi.fn(async () => false)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Second call within TTL — should not call isRunning
    const isRunningBefore = (mockDocker.isRunning as ReturnType<typeof vi.fn>).mock.calls.length
    const name = await manager.ensureRunning('test-wt', '/tmp/project')
    const isRunningAfter = (mockDocker.isRunning as ReturnType<typeof vi.fn>).mock.calls.length

    expect(name).toBe('forge-test-wt')
    expect(isRunningAfter - isRunningBefore).toBe(0)
    expect(mockDocker.createContainer).toHaveBeenCalledTimes(1)
  })

  it('recreates container when it dies between calls', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    // First call creates
    mockDocker.isRunning = vi.fn(async () => false)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Advance beyond TTL so next call performs a real liveness check
    vi.advanceTimersByTime(3_000)

    // Container is now dead
    mockDocker.isRunning = vi.fn(async () => false)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // createContainer should have been called again since container died
    expect(mockDocker.createContainer).toHaveBeenCalledTimes(2)
  })

  it('removes dead container from Docker before recreating to avoid name conflict', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    // First call creates the container
    mockDocker.isRunning = vi.fn(async () => false)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Advance beyond TTL
    vi.advanceTimersByTime(3_000)

    // Container died but still exists in Docker (isRunning returns false)
    mockDocker.isRunning = vi.fn(async () => false)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // Must remove the stopped container to avoid name conflict on docker run --name
    expect(mockDocker.removeContainer).toHaveBeenCalledWith('forge-test-wt')
    // Must create a new container after removing the old one
    expect(mockDocker.createContainer).toHaveBeenCalledTimes(2)
  })

  it('restore delegates to ensureRunning and recreates dead container', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    // No active entry (simulates process restart or stale map cleanup)
    expect(manager.isActive('test-wt')).toBe(false)

    // Container exists in Docker but is stopped
    mockDocker.isRunning = vi.fn(async () => false)

    await manager.restore('test-wt', '/tmp/project', new Date().toISOString())

    // Must have removed the stopped container to avoid name conflict
    expect(mockDocker.removeContainer).toHaveBeenCalledWith('forge-test-wt')
    // Must have created a new container
    expect(mockDocker.createContainer).toHaveBeenCalledTimes(1)
    // Map should now have the active entry
    expect(manager.isActive('test-wt')).toBe(true)
  })

  it('reuses a running container when no active map entry exists (process restart scenario)', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    // No active entry (simulates process restart or stale map cleanup)
    expect(manager.isActive('test-wt')).toBe(false)

    // Docker still has a running container
    mockDocker.isRunning = vi.fn(async () => true)

    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // Must NOT create a new container
    expect(mockDocker.createContainer).not.toHaveBeenCalled()
    // Must NOT remove the existing running container
    expect(mockDocker.removeContainer).not.toHaveBeenCalled()
    // Map must be populated with the existing container
    const active = manager.getActive('test-wt')
    expect(active).not.toBeNull()
    expect(active!.containerName).toBe('forge-test-wt')
    expect(active!.projectDir.length).toBeGreaterThan(0)
    expect(active!.mounts.length).toBeGreaterThanOrEqual(1)
  })

  it('repopulates mounts for a running container after TTL expires', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockDocker as DockerService, config, mockLogger as Logger)

    // First call creates
    mockDocker.isRunning = vi.fn(async () => false)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Advance beyond TTL
    vi.advanceTimersByTime(3_000)

    // Container is still running — should repopulate mounts
    mockDocker.isRunning = vi.fn(async () => true)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // isRunning called once (TTL expired)
    expect(mockDocker.isRunning).toHaveBeenCalledTimes(1)
    // createContainer should NOT have been called again
    expect(mockDocker.createContainer).toHaveBeenCalledTimes(1)
  })
})
