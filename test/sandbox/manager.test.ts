import { describe, it, expect, vi } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockSandboxRuntime, createMockLogger } from '../helpers/sandbox-mocks'

describe('SandboxManager.isLiveByName', () => {
  it('should return true when runtime reports sandbox is running', async () => {
    const mockRuntime = createMockSandboxRuntime()
    mockRuntime.isRunning = vi.fn(async () => true)
    const mockLogger = createMockLogger()

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    const result = await manager.isLiveByName('test-worktree')

    expect(result).toBe(true)
    expect(mockRuntime.isRunning).toHaveBeenCalledWith('forge-test-worktree')
  })

  it('should return false when runtime reports sandbox is not running', async () => {
    const mockRuntime = createMockSandboxRuntime()
    mockRuntime.isRunning = vi.fn(async () => false)
    const mockLogger = createMockLogger()

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    const result = await manager.isLiveByName('test-worktree')

    expect(result).toBe(false)
    expect(mockRuntime.isRunning).toHaveBeenCalledWith('forge-test-worktree')
  })

  it('should not modify activeSandboxes map', async () => {
    const mockRuntime = createMockSandboxRuntime()
    mockRuntime.isRunning = vi.fn(async () => true)
    const mockLogger = createMockLogger()

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    // Map should be empty initially
    expect(manager.isActive('test-worktree')).toBe(false)

    await manager.isLiveByName('test-worktree')

    // Map should still be empty - isLiveByName doesn't modify it
    expect(manager.isActive('test-worktree')).toBe(false)
  })
})
