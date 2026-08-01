import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import type { SbxAvailability } from '../../src/sandbox/sbx'
import { createMockSandboxRuntime, createMockLogger } from '../helpers/sandbox-mocks'

const available: SbxAvailability = { available: true }
const daemonDown: SbxAvailability = { available: false, reason: 'daemon-down', detail: 'mock daemon down' }

describe('SandboxManager caching', () => {
  let mockRuntime: ReturnType<typeof createMockSandboxRuntime>
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    mockRuntime = createMockSandboxRuntime()
    mockRuntime.checkAvailable = vi.fn(async (): Promise<SbxAvailability> => available)
    mockRuntime.templateExists = vi.fn(async () => true)
    mockRuntime.isRunning = vi.fn(async () => false)
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should cache checkAvailable and latch templateExists across two start() calls', async () => {
    mockRuntime.isRunning = vi.fn()
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => true)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await manager.start('test-wt', '/tmp/project')

    await manager.start('test-wt', '/tmp/project')

    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)
    expect(mockRuntime.templateExists).toHaveBeenCalledTimes(1)
  })

  it('should reject both calls when runtime is unavailable and cache negative result within TTL', async () => {
    mockRuntime.checkAvailable = vi.fn(async (): Promise<SbxAvailability> => daemonDown)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('daemon is not running')
    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)

    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('daemon is not running')
    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_000)
    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('daemon is not running')
    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(2)
  })

  it('should not call checkAvailable or templateExists when restore delegates to start and cache is warm', async () => {
    mockRuntime.isRunning = vi.fn(async () => false)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await manager.start('test-wt', '/tmp/project')
    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)
    expect(mockRuntime.templateExists).toHaveBeenCalledTimes(1)

    mockRuntime.isRunning = vi.fn(async () => false)
    await manager.restore('other-wt', '/tmp/project', new Date().toISOString())

    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)
    expect(mockRuntime.templateExists).toHaveBeenCalledTimes(1)
  })
})
