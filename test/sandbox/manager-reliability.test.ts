import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockSandboxRuntime, createMockLogger } from '../helpers/sandbox-mocks'

describe('SandboxManager.ensureRunning', () => {
  let mockRuntime: ReturnType<typeof createMockSandboxRuntime>
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    mockRuntime = createMockSandboxRuntime()
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
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
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    await manager.ensureRunning('test-wt', '/tmp/project')
    const createCountAfterFirst = (mockRuntime.createSandbox as ReturnType<typeof vi.fn>).mock.calls.length

    // Second call: sandbox is now in map and runtime reports it running
    mockRuntime.getSandboxState = vi.fn(async () => 'running' as const)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // createSandbox should not have been called again
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(createCountAfterFirst)
  })

  it('skips the liveness query when called within 2s TTL', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // First call creates the sandbox
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Second call within TTL — should not query sandbox state
    const stateCallsBefore = (mockRuntime.getSandboxState as ReturnType<typeof vi.fn>).mock.calls.length
    const name = await manager.ensureRunning('test-wt', '/tmp/project')
    const stateCallsAfter = (mockRuntime.getSandboxState as ReturnType<typeof vi.fn>).mock.calls.length

    expect(name).toBe('forge-test-wt')
    expect(stateCallsAfter - stateCallsBefore).toBe(0)
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(1)
  })

  it('recreates sandbox when it dies between calls', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // First call creates
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Advance beyond TTL so next call performs a real liveness check
    vi.advanceTimersByTime(3_000)

    // Sandbox is now dead
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    // createSandbox should have been called again since sandbox died
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(2)
  })

  it('reuses a stopped sandbox instead of removing and recreating it', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // First call creates the sandbox
    await manager.ensureRunning('test-wt', '/tmp/project')
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(1)

    // Advance beyond TTL so the next call performs a real state check
    vi.advanceTimersByTime(3_000)

    // sbx suspends idle microVMs to `stopped`; `sbx exec` resumes them in place
    mockRuntime.getSandboxState = vi.fn(async () => 'stopped' as const)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    expect(mockRuntime.removeSandbox).not.toHaveBeenCalled()
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(1)
  })

  it('single-flights concurrent ensureRunning calls into one create', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    const [a, b, c] = await Promise.all([
      manager.ensureRunning('test-wt', '/tmp/project'),
      manager.ensureRunning('test-wt', '/tmp/project'),
      manager.ensureRunning('test-wt', '/tmp/project'),
    ])

    expect([a, b, c]).toEqual(['forge-test-wt', 'forge-test-wt', 'forge-test-wt'])
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(1)
  })

  it('never removes a sandbox when the state query fails', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await manager.ensureRunning('test-wt', '/tmp/project')
    vi.advanceTimersByTime(3_000)

    // A failed `sbx ls` says nothing about the sandbox and must not destroy it
    mockRuntime.getSandboxState = vi.fn(async () => 'unknown' as const)
    const name = await manager.ensureRunning('test-wt', '/tmp/project')

    expect(name).toBe('forge-test-wt')
    expect(mockRuntime.removeSandbox).not.toHaveBeenCalled()
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(1)
  })

  it('restore delegates to ensureRunning and recreates a missing sandbox', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // No active entry (simulates process restart or stale map cleanup)
    expect(manager.isActive('test-wt')).toBe(false)

    // Sandbox is genuinely gone from the runtime
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)

    await manager.restore('test-wt', '/tmp/project', new Date().toISOString())

    // A confirmed-missing sandbox has nothing to remove
    expect(mockRuntime.removeSandbox).not.toHaveBeenCalled()
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
    mockRuntime.getSandboxState = vi.fn(async () => 'running' as const)

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
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    await manager.ensureRunning('test-wt', '/tmp/project')

    // Advance beyond TTL
    vi.advanceTimersByTime(3_000)

    // Sandbox is still running — the reuse path must rebuild the entry rather than return the
    // cached container name untouched. A different project dir makes that observable: the mount
    // plan and projectDir only track it if repopulation actually ran.
    mockRuntime.getSandboxState = vi.fn(async () => 'running' as const)
    const name = await manager.ensureRunning('test-wt', '/tmp/project-moved')

    expect(name).toBe('forge-test-wt')
    // getSandboxState called once (TTL expired)
    expect(mockRuntime.getSandboxState).toHaveBeenCalledTimes(1)
    // createSandbox should NOT have been called again
    expect(mockRuntime.createSandbox).toHaveBeenCalledTimes(1)

    const active = manager.getActive('test-wt')
    expect(active).not.toBeNull()
    expect(active!.projectDir).toContain('project-moved')
    expect(active!.mounts.some((m) => m.hostDir.includes('project-moved'))).toBe(true)
  })

  it('stop rethrows a removal failure but still clears the active map entry', async () => {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    await manager.ensureRunning('test-wt', '/tmp/project')
    expect(manager.isActive('test-wt')).toBe(true)

    // Runtime removal fails: the container may still be live, so stop() must surface the failure
    // (callers that own the lifecycle can record it) while still cleaning up the in-memory entry.
    mockRuntime.removeSandbox = vi.fn(async () => {
      throw new Error('container removal failed')
    })

    await expect(manager.stop('test-wt')).rejects.toThrow(/container removal failed/)
    // Cleanup is preserved: the stale map entry is gone even though removal failed.
    expect(manager.isActive('test-wt')).toBe(false)
  })
})
