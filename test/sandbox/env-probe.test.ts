import { describe, test, expect, vi } from 'vitest'
import { createEnvironmentProbe, formatEnvironmentDescriptor, ENV_PROBE_COMMAND } from '../../src/sandbox/env-probe'
import type { SandboxContext } from '../../src/sandbox/context'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

function sandboxWith(exec: SandboxContext['runtime']['exec'], containerName = 'forge-x'): SandboxContext {
  return { runtime: { exec }, containerName, hostDir: '/w', mounts: [] } as unknown as SandboxContext
}

describe('formatEnvironmentDescriptor', () => {
  test('joins the probe lines into one bounded descriptor', () => {
    expect(formatEnvironmentDescriptor('Linux 6.1.0 aarch64\nDebian GNU/Linux 12 (bookworm)\n'))
      .toBe('Linux 6.1.0 aarch64 | Debian GNU/Linux 12 (bookworm)')
  })

  test('returns null for empty output', () => {
    expect(formatEnvironmentDescriptor('  \n\n')).toBeNull()
  })

  test('caps runaway output', () => {
    expect(formatEnvironmentDescriptor('x'.repeat(500))).toHaveLength(200)
  })
})

describe('createEnvironmentProbe', () => {
  test('describes a container with the shared probe command', async () => {
    const exec = vi.fn(async () => ({ stdout: 'Linux 6.1.0 aarch64\nDebian GNU/Linux 12', stderr: '', exitCode: 0 }))
    const probe = createEnvironmentProbe(logger)

    expect(await probe.describeSandbox(sandboxWith(exec))).toBe('Linux 6.1.0 aarch64 | Debian GNU/Linux 12')
    expect(exec).toHaveBeenCalledWith('forge-x', ENV_PROBE_COMMAND, expect.objectContaining({ cwd: '/w' }))
  })

  test('probes each container once however many requests observe it', async () => {
    const exec = vi.fn(async () => ({ stdout: 'Linux 6.1.0 aarch64', stderr: '', exitCode: 0 }))
    const probe = createEnvironmentProbe(logger)
    const sandbox = sandboxWith(exec)

    await Promise.all([probe.describeSandbox(sandbox), probe.describeSandbox(sandbox)])
    await probe.describeSandbox(sandbox)

    expect(exec).toHaveBeenCalledTimes(1)
  })

  test('caches per container name', async () => {
    const exec = vi.fn(async (name: string) => ({ stdout: `Linux ${name}`, stderr: '', exitCode: 0 }))
    const probe = createEnvironmentProbe(logger)

    expect(await probe.describeSandbox(sandboxWith(exec, 'forge-a'))).toBe('Linux forge-a')
    expect(await probe.describeSandbox(sandboxWith(exec, 'forge-b'))).toBe('Linux forge-b')
    expect(exec).toHaveBeenCalledTimes(2)
  })

  test('returns null on a failed probe without retrying it per request', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'boom', exitCode: 1 }))
    const probe = createEnvironmentProbe(logger)
    const sandbox = sandboxWith(exec)

    expect(await probe.describeSandbox(sandbox)).toBeNull()
    expect(await probe.describeSandbox(sandbox)).toBeNull()
    expect(exec).toHaveBeenCalledTimes(1)
  })

  test('returns null when the runtime throws', async () => {
    const exec = vi.fn(async () => { throw new Error('no sandbox') })
    const probe = createEnvironmentProbe(logger)

    expect(await probe.describeSandbox(sandboxWith(exec))).toBeNull()
  })

  test('describes the host once', async () => {
    const probe = createEnvironmentProbe(logger)

    const first = await probe.describeHost()
    const second = await probe.describeHost()

    expect(first).toBe(second)
    expect(first).toMatch(/\S/)
  })
})
