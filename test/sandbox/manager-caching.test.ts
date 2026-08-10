import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import type { SbxAvailability } from '../../src/sandbox/sbx'
import { createMockSandboxRuntime, createMockLogger } from '../helpers/sandbox-mocks'

const available: SbxAvailability = { available: true }
const daemonDown: SbxAvailability = { available: false, reason: 'daemon-down', detail: 'mock daemon down' }
const indeterminate: SbxAvailability = { available: false, reason: 'unknown', detail: 'probe timed out' }

describe('SandboxManager caching', () => {
  let mockRuntime: ReturnType<typeof createMockSandboxRuntime>
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    mockRuntime = createMockSandboxRuntime()
    mockRuntime.checkAvailable = vi.fn(async (): Promise<SbxAvailability> => available)
    mockRuntime.templateExists = vi.fn(async () => true)
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should cache checkAvailable and latch templateExists across two start() calls', async () => {
    mockRuntime.getSandboxState = vi.fn()
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => true)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await manager.start('test-wt', '/tmp/project')

    await manager.start('test-wt', '/tmp/project')

    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)
    expect(mockRuntime.templateExists).toHaveBeenCalledTimes(1)
  })

  it('should not start a keep-alive exec', async () => {
    mockRuntime.exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const manager = createSandboxManager(mockRuntime, { image: 'oc-forge-sandbox:latest' }, mockLogger)

    await manager.start('test-wt', '/tmp/project')

    expect(mockRuntime.exec).not.toHaveBeenCalled()
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
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await manager.start('test-wt', '/tmp/project')
    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)
    expect(mockRuntime.templateExists).toHaveBeenCalledTimes(1)

    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    await manager.restore('other-wt', '/tmp/project', new Date().toISOString())

    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)
    expect(mockRuntime.templateExists).toHaveBeenCalledTimes(1)
  })

  it('should start the sandbox when availability is indeterminate instead of failing the launch', async () => {
    // A busy daemon cannot answer the probe in time; that must not block a concurrent loop launch.
    mockRuntime.checkAvailable = vi.fn(async (): Promise<SbxAvailability> => indeterminate)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await expect(manager.start('test-wt', '/tmp/project')).resolves.toEqual({ containerName: 'forge-test-wt' })
    expect(mockRuntime.getCreateSandboxCalls()).toHaveLength(1)
  })

  it('should not cache an indeterminate probe, so the next launch re-probes immediately', async () => {
    mockRuntime.checkAvailable = vi.fn(async (): Promise<SbxAvailability> => indeterminate)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await manager.start('wt-a', '/tmp/project')
    await manager.start('wt-b', '/tmp/project')

    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(2)
  })

  it('should report an unreachable daemon rather than a missing template', async () => {
    // `sbx template ls` failing looks identical to an absent template, so the daemon error wins.
    mockRuntime.checkAvailable = vi.fn(async (): Promise<SbxAvailability> => available)
    mockRuntime.templateExists = vi.fn(async () => false)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    mockRuntime.checkAvailable = vi.fn(async (): Promise<SbxAvailability> => daemonDown)
    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('daemon is not running')
  })

  it('should defer an indeterminate template query to sandbox creation', async () => {
    mockRuntime.templateExists = vi.fn(async () => false)
    mockRuntime.checkAvailable = vi.fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(indeterminate)

    const manager = createSandboxManager(mockRuntime, { image: 'oc-forge-sandbox:latest' }, mockLogger)

    await expect(manager.start('test-wt', '/tmp/project')).resolves.toEqual({ containerName: 'forge-test-wt' })
    expect(mockRuntime.getCreateSandboxCalls()).toHaveLength(1)
  })
})
