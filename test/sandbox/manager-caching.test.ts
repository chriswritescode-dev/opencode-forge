import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import type { MsbAvailability } from '../../src/sandbox/msb'
import { createMockSandboxRuntime } from '../helpers/sandbox-mocks'
import { createMockLogger } from '../helpers/logger'

const available: MsbAvailability = { available: true }
const hostUnsupported: MsbAvailability = { available: false, reason: 'host-unsupported', detail: 'mock daemon down' }
const indeterminate: MsbAvailability = { available: false, reason: 'unknown', detail: 'probe timed out' }

describe('SandboxManager caching', () => {
  let mockRuntime: ReturnType<typeof createMockSandboxRuntime>
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    mockRuntime = createMockSandboxRuntime()
    mockRuntime.checkAvailable = vi.fn(async (): Promise<MsbAvailability> => available)
    mockRuntime.checkTemplate = vi.fn(mockRuntime.checkTemplate)
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should cache checkAvailable and latch checkTemplate across two start() calls', async () => {
    mockRuntime.getSandboxState = vi.fn()
      .mockImplementationOnce(async () => 'missing' as const)
      .mockImplementationOnce(async () => 'running' as const)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await manager.start('test-wt', '/tmp/project')

    await manager.start('test-wt', '/tmp/project')

    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)
    expect(mockRuntime.checkTemplate).toHaveBeenCalledTimes(1)
  })

  it('should not start a keep-alive exec; the only exec is the create-time cache prepare', async () => {
    mockRuntime.exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const manager = createSandboxManager(mockRuntime, { image: 'oc-forge-sandbox:latest' }, mockLogger)

    await manager.start('test-wt', '/tmp/project')

    expect(mockRuntime.exec).toHaveBeenCalledTimes(1)
  })

  it('should reject both calls when runtime is unavailable and cache negative result within TTL', async () => {
    mockRuntime.checkAvailable = vi.fn(async (): Promise<MsbAvailability> => hostUnsupported)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('This host cannot run microVMs')
    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)

    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('This host cannot run microVMs')
    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_000)
    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('This host cannot run microVMs')
    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(2)
  })

  it('should not call checkAvailable or checkTemplate when restore delegates to start and cache is warm', async () => {
    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await manager.start('test-wt', '/tmp/project')
    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)
    expect(mockRuntime.checkTemplate).toHaveBeenCalledTimes(1)

    mockRuntime.getSandboxState = vi.fn(async () => 'missing' as const)
    await manager.restore('other-wt', '/tmp/project', new Date().toISOString())

    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(1)
    expect(mockRuntime.checkTemplate).toHaveBeenCalledTimes(1)
  })

  it('should start the sandbox when availability is indeterminate instead of failing the launch', async () => {
    // A busy daemon cannot answer the probe in time; that must not block a concurrent loop launch.
    mockRuntime.checkAvailable = vi.fn(async (): Promise<MsbAvailability> => indeterminate)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await expect(manager.start('test-wt', '/tmp/project')).resolves.toEqual({ containerName: 'forge-test-wt' })
    expect(mockRuntime.getCreateSandboxCalls()).toHaveLength(1)
  })

  it('should not cache an indeterminate probe, so the next launch re-probes immediately', async () => {
    mockRuntime.checkAvailable = vi.fn(async (): Promise<MsbAvailability> => indeterminate)

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await manager.start('wt-a', '/tmp/project')
    await manager.start('wt-b', '/tmp/project')

    expect(mockRuntime.checkAvailable).toHaveBeenCalledTimes(2)
  })

  it('should report an unavailable host rather than a missing template', async () => {
    // `msb images` failing looks identical to an absent template, so the availability error wins.
    mockRuntime.checkAvailable = vi.fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(hostUnsupported)
    mockRuntime.checkTemplate = vi.fn(async () => ({ kind: 'missing' as const }))

    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }
    const manager = createSandboxManager(mockRuntime, config, mockLogger)

    await expect(manager.start('test-wt', '/tmp/project')).rejects.toThrow('This host cannot run microVMs')
    expect(mockRuntime.checkTemplate).toHaveBeenCalledTimes(1)
  })

  it('should defer an indeterminate template query to sandbox creation', async () => {
    mockRuntime.checkTemplate = vi.fn(async () => ({ kind: 'missing' as const }))
    mockRuntime.checkAvailable = vi.fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(indeterminate)

    const manager = createSandboxManager(mockRuntime, { image: 'oc-forge-sandbox:latest' }, mockLogger)

    await expect(manager.start('test-wt', '/tmp/project')).resolves.toEqual({ containerName: 'forge-test-wt' })
    expect(mockRuntime.getCreateSandboxCalls()).toHaveLength(1)
  })

  it('should reject with the msb images detail when the template check fails, then retry once it succeeds', async () => {
    mockRuntime.setTemplateStatus({ kind: 'failed', detail: 'catalog ancestor /home/u/.microsandbox permits path substitution' })

    const manager = createSandboxManager(mockRuntime, { image: 'oc-forge-sandbox:latest' }, mockLogger)

    const error = await manager.start('test-wt', '/tmp/project').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('catalog ancestor')
    expect((error as Error).message).not.toContain('not found')
    expect(mockRuntime.getCreateSandboxCalls()).toHaveLength(0)

    mockRuntime.setTemplateStatus({ kind: 'present' })
    await expect(manager.start('test-wt', '/tmp/project')).resolves.toEqual({ containerName: 'forge-test-wt' })
    expect(mockRuntime.checkTemplate).toHaveBeenCalledTimes(2)
  })

  it('should continue when the template query is indeterminate', async () => {
    mockRuntime.setTemplateStatus({ kind: 'unknown', detail: 'spawn msb timed out' })

    const manager = createSandboxManager(mockRuntime, { image: 'oc-forge-sandbox:latest' }, mockLogger)

    await expect(manager.start('test-wt', '/tmp/project')).resolves.toEqual({ containerName: 'forge-test-wt' })
    expect(mockRuntime.getCreateSandboxCalls()).toHaveLength(1)
  })
})
