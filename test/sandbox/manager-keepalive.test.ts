import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSandboxManager,
  SANDBOX_KEEPALIVE_INTERVAL_MS,
  type SandboxManagerConfig,
} from '../../src/sandbox/manager'
import { createMockSandboxRuntime, createMockLogger } from '../helpers/sandbox-mocks'
import type { CommandResult } from '../../src/sandbox/process'

describe('SandboxManager keep-alive', () => {
  let mockRuntime: ReturnType<typeof createMockSandboxRuntime>
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    mockRuntime = createMockSandboxRuntime()
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    mockRuntime.createSandbox = vi.fn(async () => {})
    mockRuntime.exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeManager(overrides: Partial<SandboxManagerConfig> = {}) {
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest', ...overrides }
    return createSandboxManager(mockRuntime, config, mockLogger)
  }

  it('issues a no-op exec exactly once per interval while a sandbox is active', async () => {
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    await vi.advanceTimersByTimeAsync(SANDBOX_KEEPALIVE_INTERVAL_MS)

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)
    expect(mockRuntime.exec).toHaveBeenCalledWith('forge-wt', 'true')
  })

  it('issues no exec when no sandbox has ever been started', async () => {
    makeManager()

    await vi.advanceTimersByTimeAsync(SANDBOX_KEEPALIVE_INTERVAL_MS * 3)

    expect(mockRuntime.exec).not.toHaveBeenCalled()
  })

  it('swallows a rejecting exec and keeps heartbeating', async () => {
    mockRuntime.exec = vi.fn(async () => {
      throw new Error('keep-alive exec failed')
    })
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    await vi.advanceTimersByTimeAsync(SANDBOX_KEEPALIVE_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(SANDBOX_KEEPALIVE_INTERVAL_MS)

    expect(mockRuntime.exec).toHaveBeenCalledTimes(2)
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('keep-alive exec for forge-wt failed'),
    )
  })

  it('issues no further exec after stop', async () => {
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')
    await manager.stop('wt')

    await vi.advanceTimersByTimeAsync(SANDBOX_KEEPALIVE_INTERVAL_MS * 2)

    expect(mockRuntime.exec).not.toHaveBeenCalled()
  })

  it('issues no further exec after dispose', async () => {
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    manager.dispose()
    await vi.advanceTimersByTimeAsync(SANDBOX_KEEPALIVE_INTERVAL_MS * 2)

    expect(mockRuntime.exec).not.toHaveBeenCalled()
  })

  it('does not start a second heartbeat while one is still pending for the same sandbox', async () => {
    mockRuntime.exec = vi.fn(() => new Promise<CommandResult>(() => {}))
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    vi.advanceTimersByTime(SANDBOX_KEEPALIVE_INTERVAL_MS)
    vi.advanceTimersByTime(SANDBOX_KEEPALIVE_INTERVAL_MS)

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)
  })

  it('issues no exec and disposes without throwing when keepAlive is false', async () => {
    const manager = makeManager({ keepAlive: false })
    await manager.start('wt', '/tmp/project')

    await vi.advanceTimersByTimeAsync(SANDBOX_KEEPALIVE_INTERVAL_MS * 3)

    expect(mockRuntime.exec).not.toHaveBeenCalled()
    expect(() => manager.dispose()).not.toThrow()
  })
})
