import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSandboxManager } from '../../src/sandbox/manager'
import { createMockSandboxRuntime, createMockLogger } from '../helpers/sandbox-mocks'
import { SANDBOX_CACHE_DIR } from '../../src/sandbox/msb'

const CACHE_PREPARE_COMMAND = `sudo sh -c 'chown agent:agent ${SANDBOX_CACHE_DIR} && chmod 0777 ${SANDBOX_CACHE_DIR}'`

describe('SandboxManager cache disk', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('chowns and chmods the cache disk root once after creating a sandbox', async () => {
    const runtime = createMockSandboxRuntime()
    runtime.getSandboxState = vi.fn(async () => 'missing' as const)
    runtime.createSandbox = vi.fn(async () => {})
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    runtime.exec = exec
    const manager = createSandboxManager(runtime, { image: 'oc-forge-sandbox:latest' }, createMockLogger())

    await manager.ensureRunning('test-wt', '/tmp/project')

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('forge-test-wt', CACHE_PREPARE_COMMAND)
  })

  it('prepares the cache disk on the adopt path', async () => {
    const runtime = createMockSandboxRuntime()
    runtime.getSandboxState = vi.fn(async () => 'running' as const)
    runtime.createSandbox = vi.fn(async () => {})
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    runtime.exec = exec
    const manager = createSandboxManager(runtime, { image: 'oc-forge-sandbox:latest' }, createMockLogger())

    await manager.ensureRunning('test-wt', '/tmp/project')

    expect(runtime.createSandbox).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('forge-test-wt', CACHE_PREPARE_COMMAND)
  })

  it('executes the cache prepare exactly once across repeated liveness re-checks of an adopted sandbox', async () => {
    vi.useFakeTimers()
    const runtime = createMockSandboxRuntime()
    runtime.getSandboxState = vi.fn(async () => 'running' as const)
    runtime.createSandbox = vi.fn(async () => {})
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    runtime.exec = exec
    const manager = createSandboxManager(runtime, { image: 'oc-forge-sandbox:latest' }, createMockLogger())

    await manager.ensureRunning('test-wt', '/tmp/project')
    vi.advanceTimersByTime(3_000)
    await manager.ensureRunning('test-wt', '/tmp/project')
    vi.advanceTimersByTime(3_000)
    await manager.ensureRunning('test-wt', '/tmp/project')

    expect(runtime.getSandboxState).toHaveBeenCalledTimes(3)
    expect(runtime.createSandbox).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('forge-test-wt', CACHE_PREPARE_COMMAND)
  })

  it('fails the start when the cache prepare fails', async () => {
    const runtime = createMockSandboxRuntime()
    runtime.getSandboxState = vi.fn(async () => 'missing' as const)
    runtime.createSandbox = vi.fn(async () => {})
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'chown: Operation not permitted', exitCode: 1 }))
    runtime.exec = exec
    const manager = createSandboxManager(runtime, { image: 'oc-forge-sandbox:latest' }, createMockLogger())

    await expect(manager.ensureRunning('test-wt', '/tmp/project')).rejects.toThrow(/cache disk/)
    expect(runtime.createSandbox).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('fails the adopt when the cache prepare fails and does not latch the failure', async () => {
    const runtime = createMockSandboxRuntime()
    runtime.getSandboxState = vi.fn(async () => 'running' as const)
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'chown: Operation not permitted', exitCode: 1 }))
    runtime.exec = exec
    const manager = createSandboxManager(runtime, { image: 'oc-forge-sandbox:latest' }, createMockLogger())

    await expect(manager.ensureRunning('test-wt', '/tmp/project')).rejects.toThrow(/cache disk/)
    await expect(manager.ensureRunning('test-wt', '/tmp/project')).rejects.toThrow(/cache disk/)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('reclaims the sandbox volumes through removeSandbox when stop finds the sandbox already gone', async () => {
    const runtime = createMockSandboxRuntime()
    runtime.getSandboxState = vi.fn(async () => 'missing' as const)
    const manager = createSandboxManager(runtime, { image: 'oc-forge-sandbox:latest' }, createMockLogger())

    await manager.stop('test-wt')

    expect(runtime.getRemoveSandboxCalls()).toContain('forge-test-wt')
    expect(manager.isActive('test-wt')).toBe(false)
  })

  it('does not fail stop when reclaiming the volumes of an already-gone sandbox errors', async () => {
    const runtime = createMockSandboxRuntime()
    runtime.getSandboxState = vi.fn(async () => 'missing' as const)
    runtime.setRemoveThrow(true)
    const manager = createSandboxManager(runtime, { image: 'oc-forge-sandbox:latest' }, createMockLogger())

    await expect(manager.stop('test-wt')).resolves.toBeUndefined()
  })

  it('forwards the configured cacheDisk size into createSandbox', async () => {
    const runtime = createMockSandboxRuntime()
    runtime.getSandboxState = vi.fn(async () => 'missing' as const)
    const manager = createSandboxManager(runtime, {
      image: 'oc-forge-sandbox:latest',
      resources: { cacheDisk: '8g' },
    }, createMockLogger())

    await manager.ensureRunning('test-wt', '/tmp/project')

    const calls = runtime.getCreateSandboxCalls()
    expect(calls[0][2]?.resources).toEqual(expect.objectContaining({ cacheDisk: '8g' }))
  })
})
