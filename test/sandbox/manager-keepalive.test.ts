import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSandboxManager,
  SANDBOX_SENTINEL_SECONDS,
  SANDBOX_SENTINEL_TIMEOUT_MS,
  type SandboxManagerConfig,
} from '../../src/sandbox/manager'
import { createMockSandboxRuntime, createMockLogger } from '../helpers/sandbox-mocks'
import type { CommandResult } from '../../src/sandbox/process'
import type { SandboxExecOpts } from '../../src/sandbox/sbx'

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

  it('issues exactly one sentinel exec with the sleep command, timeout, and an AbortSignal', async () => {
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)
    expect(mockRuntime.exec).toHaveBeenCalledWith('forge-wt', `sleep ${SANDBOX_SENTINEL_SECONDS}`, {
      timeout: SANDBOX_SENTINEL_TIMEOUT_MS,
      abort: expect.any(AbortSignal),
    })
  })

  it('does not poll while a sentinel is still in flight', async () => {
    mockRuntime.exec = vi.fn(() => new Promise<CommandResult>(() => {}))
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)
  })

  it('renews with a fresh sentinel exec once the sleep has fully elapsed', async () => {
    mockRuntime.exec = vi.fn(
      () =>
        new Promise<CommandResult>((resolve) => {
          setTimeout(() => resolve({ stdout: '', stderr: '', exitCode: 0 }), SANDBOX_SENTINEL_SECONDS * 1000)
        }),
    )
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SANDBOX_SENTINEL_SECONDS * 1000)
    expect(mockRuntime.exec).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(SANDBOX_SENTINEL_SECONDS * 1000)
    expect(mockRuntime.exec).toHaveBeenCalledTimes(3)
  })

  it('does not renew and logs when the exec returns faster than the minimum', async () => {
    mockRuntime.exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)
    expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('not renewing'))
  })

  it('stops renewal and logs when the sentinel exits non-zero', async () => {
    mockRuntime.exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 }))
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)
    expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('exited 1'))
  })

  it('stops renewal and logs a throwing sentinel without rejecting', async () => {
    mockRuntime.exec = vi.fn(async () => {
      throw new Error('keep-alive exec failed')
    })
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('keep-alive sentinel for forge-wt failed'),
    )

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)
  })

  it('aborts the sentinel signal before removing the sandbox on stop', async () => {
    let capturedSignal: AbortSignal | undefined
    let abortedAtRemoval = false
    mockRuntime.exec = vi.fn(
      (_name: string, _command: string, opts?: SandboxExecOpts) => {
        capturedSignal = opts?.abort
        return new Promise<CommandResult>(() => {})
      },
    )
    mockRuntime.removeSandbox = vi.fn(async (_name: string) => {
      abortedAtRemoval = capturedSignal?.aborted === true
    })
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    expect(capturedSignal).toBeDefined()

    await manager.stop('wt')

    expect(abortedAtRemoval).toBe(true)
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('dispose aborts the sentinel without removing or stopping any sandbox', async () => {
    let capturedSignal: AbortSignal | undefined
    mockRuntime.exec = vi.fn(
      (_name: string, _command: string, opts?: SandboxExecOpts) => {
        capturedSignal = opts?.abort
        return new Promise<CommandResult>(() => {})
      },
    )
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    expect(capturedSignal?.aborted).toBe(false)

    manager.dispose()

    expect(capturedSignal?.aborted).toBe(true)
    expect(mockRuntime.getRemoveSandboxCalls()).toEqual([])
    expect(manager.isActive('wt')).toBe(true)
  })

  it('starts a fresh sentinel when ensureRunning re-registers a worktree after renewal stopped', async () => {
    mockRuntime.exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const manager = makeManager()
    await manager.start('wt', '/tmp/project')

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)
    expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('not renewing'))

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)

    await manager.ensureRunning('wt', '/tmp/project')

    expect(mockRuntime.exec).toHaveBeenCalledTimes(2)
  })
})
