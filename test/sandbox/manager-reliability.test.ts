import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockSandboxRuntime, createMockLogger } from '../helpers/sandbox-mocks'

describe('SandboxManager.ensureRunning', () => {
  let mockRuntime: ReturnType<typeof createMockSandboxRuntime>
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    mockRuntime = createMockSandboxRuntime()
    mockRuntime.isRunning = vi.fn(async () => false)
    mockRuntime.createSandbox = vi.fn(async () => {})
    mockRuntime.removeSandbox = vi.fn(async () => {})
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a new sandbox when no active sandbox exists', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(1)
  })

  it('reuses a running sandbox without calling start', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // First call creates
    mockRuntime.isRunning = vi.fn(async () => false)
    await manager.ensureRunning('test-wt', '/tmp/project')
    const createCountAfterFirst = (mockRuntime.createSandbox as ReturnType<typeof vi.fn>).mock.calls.length

    // Second call: sandbox is now in map and runtime reports it running
    mockRuntime.isRunning = vi.fn(async () => true)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // createSandbox should not have been called again
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(createCountAfterFirst)
  })

  it('skips isRunning when called within 2s TTL', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // First call creates the sandbox
    mockRuntime.isRunning = vi.fn(async () => false)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Second call within TTL — should not call isRunning
    const isRunningBefore = (mockRuntime.isRunning as ReturnType<typeof vi.fn>).mock.calls.length
    const name = await manager.ensureRunning('test-wt', '/tmp/project')
    const isRunningAfter = (mockRuntime.isRunning as ReturnType<typeof vi.fn>).mock.calls.length

    expect(name).toBe('forge-test-wt')
    expect(isRunningAfter - isRunningBefore).toBe(0)
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(1)
  })

  it('recreates sandbox when it dies between calls', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // First call creates
    mockRuntime.isRunning = vi.fn(async () => false)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Advance beyond TTL so next call performs a real liveness check
    vi.advanceTimersByTime(3_000)

    // Sandbox is now dead
    mockRuntime.isRunning = vi.fn(async () => false)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // createSandbox should have been called again since sandbox died
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(2)
  })

  it('removes dead sandbox before recreating to avoid name conflict', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // First call creates the sandbox
    mockRuntime.isRunning = vi.fn(async () => false)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Advance beyond TTL
    vi.advanceTimersByTime(3_000)

    // Sandbox died but still exists in runtime (isRunning returns false)
    mockRuntime.isRunning = vi.fn(async () => false)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // Must remove the stopped sandbox to avoid name conflict
    expect(mockRuntime.removeSandbox).toHaveBeenCalledWith('forge-test-wt')
    // Must create a new sandbox after removing the old one
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(2)
  })

  it('restore delegates to ensureRunning and recreates dead sandbox', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // No active entry (simulates process restart or stale map cleanup)
    expect(manager.isActive('test-wt')).toBe(false)

    // Sandbox exists in runtime but is stopped
    mockRuntime.isRunning = vi.fn(async () => false)

    await manager.restore('test-wt', '/tmp/project', new Date().toISOString())

    // Must have removed the stopped sandbox to avoid name conflict
    expect(mockRuntime.removeSandbox).toHaveBeenCalledWith('forge-test-wt')
    // Must have created a new sandbox
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(1)
    // Map should now have the active entry
    expect(manager.isActive('test-wt')).toBe(true)
  })

  it('reuses a running sandbox when no active map entry exists (process restart scenario)', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // No active entry (simulates process restart or stale map cleanup)
    expect(manager.isActive('test-wt')).toBe(false)

    // Runtime still has a running sandbox
    mockRuntime.isRunning = vi.fn(async () => true)

    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // Must NOT create a new sandbox
    expect(mockRuntime.createSandbox).not.toHaveBeenCalled()
    // Must NOT remove the existing running sandbox
    expect(mockRuntime.removeSandbox).not.toHaveBeenCalled()
    // Map must be populated with the existing sandbox
    const active = manager.getActive('test-wt')
    expect(active).not.toBeNull()
    expect(active!.containerName).toBe('forge-test-wt')
    expect(active!.projectDir.length).toBeGreaterThan(0)
    expect(active!.mounts.length).toBeGreaterThanOrEqual(1)
  })

  it('repopulates mounts for a running sandbox after TTL expires', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // First call creates
    mockRuntime.isRunning = vi.fn(async () => false)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Advance beyond TTL
    vi.advanceTimersByTime(3_000)

    // Sandbox is still running — should repopulate mounts
    mockRuntime.isRunning = vi.fn(async () => true)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // isRunning called once (TTL expired)
    expect(mockRuntime.isRunning).toHaveBeenCalledTimes(1)
    // createSandbox should NOT have been called again
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(1)
  })
})
