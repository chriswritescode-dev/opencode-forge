import { describe, test, expect, afterEach } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockLogger, createMockSandboxRuntime } from '../helpers/sandbox-mocks'

function makeConfig(allow?: string[]): SandboxManagerConfig {
  return allow === undefined
    ? { image: 'oc-forge-sandbox:latest' }
    : { image: 'oc-forge-sandbox:latest', network: { allow } }
}

describe('SandboxManager network allowlist', () => {
  const savedEnv: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    Object.keys(savedEnv).forEach((k) => delete savedEnv[k])
  })

  function setEnv(name: string, value: string | undefined) {
    if (!(name in savedEnv)) {
      savedEnv[name] = process.env[name]
    }
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }

  test('configured hosts are forwarded as create-time networkAllow once per createSandbox', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()

    const manager = createSandboxManager(
      runtime,
      makeConfig(['registry.npmjs.org', 'pypi.org']),
      logger,
    )

    await manager.start('test', '/home/user/worktrees/feature')
    await manager.start('test', '/home/user/worktrees/feature')

    const createCalls = runtime.getCreateSandboxCalls()
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0][2]?.networkAllow).toEqual(['registry.npmjs.org', 'pypi.org'])
  })

  test('blank allow entries are trimmed out before being forwarded', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()

    const manager = createSandboxManager(runtime, makeConfig(['  ', 'pypi.org', '']), logger)

    await manager.start('test', '/home/user/worktrees/feature')

    const createCalls = runtime.getCreateSandboxCalls()
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0][2]?.networkAllow).toEqual(['pypi.org'])
  })

  test('an empty union is forwarded when allow is absent', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()

    const manager = createSandboxManager(runtime, makeConfig(undefined), logger)

    await manager.start('test', '/home/user/worktrees/feature')

    const createCalls = runtime.getCreateSandboxCalls()
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0][2]?.networkAllow).toEqual([])
  })

  test('an empty allow array forwards no hosts but still creates', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()

    const manager = createSandboxManager(runtime, makeConfig([]), logger)

    await manager.start('test', '/home/user/worktrees/feature')

    const createCalls = runtime.getCreateSandboxCalls()
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0][2]?.networkAllow).toEqual([])
  })

  test('secret destination hosts are unioned into the create-time networkAllow', async () => {
    setEnv('FORGE_TEST_TOKEN', 'v')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        allow: ['api.github.com'],
        secrets: [{ env: 'FORGE_TEST_TOKEN', hosts: ['api.github.com', '*.githubusercontent.com'] }],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    // api.github.com appears exactly once despite being in both allow and the secret hosts.
    expect(createCall[2]?.networkAllow).toEqual(['api.github.com', '*.githubusercontent.com'])
    expect(createCall[2]?.secrets).toEqual([
      { env: 'FORGE_TEST_TOKEN', hosts: ['api.github.com', '*.githubusercontent.com'] },
    ])
  })

  test('secrets-only egress is reachable: secret hosts become net-rules without an allow list', async () => {
    setEnv('FORGE_TEST_TOKEN', 'v')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_TOKEN', hosts: ['api.github.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.networkAllow).toEqual(['api.github.com'])
  })

  test('hosts of unset or misconfigured secrets are not unioned into the allow list', async () => {
    setEnv('FORGE_TEST_UNSET', undefined)

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        allow: ['pypi.org'],
        secrets: [
          { env: 'FORGE_TEST_UNSET', hosts: ['api.github.com'] },
          { env: '', hosts: ['api.example.com'] },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.networkAllow).toEqual(['pypi.org'])
  })

  test('adopting an existing sandbox performs no create call, so egress rules are not re-applied', async () => {
    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    const logger = createMockLogger()

    const manager = createSandboxManager(
      runtime,
      makeConfig(['registry.npmjs.org']),
      logger,
    )

    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
  })
})
