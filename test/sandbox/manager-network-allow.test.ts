import { describe, test, expect, vi } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockLogger, createMockSandboxRuntime } from '../helpers/sandbox-mocks'

function makeConfig(allow?: string[]): SandboxManagerConfig {
  return allow === undefined
    ? { image: 'oc-forge-sandbox:latest' }
    : { image: 'oc-forge-sandbox:latest', network: { allow } }
}

describe('SandboxManager network allowlist', () => {
  test('each configured host is allowed exactly once across two start calls', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const allowNetworkHost = vi.fn(async () => true)
    runtime.allowNetworkHost = allowNetworkHost

    const manager = createSandboxManager(
      runtime,
      makeConfig(['registry.npmjs.org', 'pypi.org']),
      logger,
    )

    await manager.start('test', '/home/user/worktrees/feature')
    await manager.start('test', '/home/user/worktrees/feature')

    expect(allowNetworkHost).toHaveBeenCalledTimes(2)
    expect(allowNetworkHost).toHaveBeenNthCalledWith(1, 'registry.npmjs.org')
    expect(allowNetworkHost).toHaveBeenNthCalledWith(2, 'pypi.org')
  })

  test('each createSandbox call receives the configured hosts as networkAllowHosts', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const manager = createSandboxManager(
      runtime,
      makeConfig(['registry.npmjs.org', 'pypi.org']),
      logger,
    )

    await manager.start('test', '/home/user/worktrees/feature')

    const calls = runtime.getCreateSandboxCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][2]?.networkAllowHosts).toEqual(['registry.npmjs.org', 'pypi.org'])
  })

  test('networkAllowHosts is absent from createSandbox opts when allow is unset', async () => {
    const runtime = createMockSandboxRuntime()
    const manager = createSandboxManager(runtime, makeConfig(undefined), createMockLogger())

    await manager.start('test', '/home/user/worktrees/feature')

    const calls = runtime.getCreateSandboxCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][2]?.networkAllowHosts).toBeUndefined()
  })

  test('a false return is logged and does not fail start', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const allowNetworkHost = vi.fn(async () => false)
    runtime.allowNetworkHost = allowNetworkHost

    const manager = createSandboxManager(runtime, makeConfig(['registry.npmjs.org']), logger)

    const result = await manager.start('test', '/home/user/worktrees/feature')

    expect(result.containerName).toBe('forge-test')
    expect(allowNetworkHost).toHaveBeenCalledTimes(1)
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('registry.npmjs.org'),
    )
  })

  test('blank entries in the allowlist are skipped', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const allowNetworkHost = vi.fn(async () => true)
    runtime.allowNetworkHost = allowNetworkHost

    const manager = createSandboxManager(
      runtime,
      makeConfig(['  ', 'pypi.org', '']),
      logger,
    )

    await manager.start('test', '/home/user/worktrees/feature')

    expect(allowNetworkHost).toHaveBeenCalledTimes(1)
    expect(allowNetworkHost).toHaveBeenCalledWith('pypi.org')
  })

  test('no allowNetworkHost call is made when allow is absent', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const allowNetworkHost = vi.fn(async () => true)
    runtime.allowNetworkHost = allowNetworkHost

    const manager = createSandboxManager(runtime, makeConfig(undefined), logger)

    await manager.start('test', '/home/user/worktrees/feature')

    expect(allowNetworkHost).not.toHaveBeenCalled()
  })

  test('no allowNetworkHost call is made when allow is empty', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const allowNetworkHost = vi.fn(async () => true)
    runtime.allowNetworkHost = allowNetworkHost

    const manager = createSandboxManager(runtime, makeConfig([]), logger)

    await manager.start('test', '/home/user/worktrees/feature')

    expect(allowNetworkHost).not.toHaveBeenCalled()
  })
})
