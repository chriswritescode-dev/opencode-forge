import { describe, test, expect, afterEach, vi } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { sandboxSecretProviders, type SandboxSecretValuesRequest } from '../../src/sandbox/secrets'
import type { SandboxOverrides } from '../../src/types'
import { createMockSandboxRuntime } from '../helpers/sandbox-mocks'
import { createMockLogger } from '../helpers/logger'

const PROVIDER_ID = 'loop-secret-provider'
const SECRET_VALUE = 'loop-secret-value'

function loopOverrides(secretProvider?: string): SandboxOverrides {
  const overrides: SandboxOverrides = { secrets: [{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }] }
  if (secretProvider) overrides.secretProvider = secretProvider
  return overrides
}

describe('SandboxManager per-loop secrets', () => {
  const savedEnv: Record<string, string | undefined> = {}

  afterEach(() => {
    sandboxSecretProviders().delete(PROVIDER_ID)
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

  function makeConfig(overrides?: SandboxOverrides, config: Partial<SandboxManagerConfig> = {}): SandboxManagerConfig {
    return {
      image: 'oc-forge-sandbox:latest',
      projectId: 'proj-1',
      resolveOverrides: (worktreeName) => worktreeName === 'test' ? overrides : undefined,
      ...config,
    }
  }

  test('calls the provider with the loop identity and passes exactly its values to createSandbox', async () => {
    const requests: SandboxSecretValuesRequest[] = []
    sandboxSecretProviders().set(PROVIDER_ID, (request) => {
      requests.push(request)
      return { LOOP_TOKEN: SECRET_VALUE, UNREQUESTED: 'ignored' }
    })
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const manager = createSandboxManager(runtime, makeConfig(loopOverrides(PROVIDER_ID)), logger)

    await manager.start('test', '/home/user/worktrees/feature')

    expect(requests).toEqual([{
      projectId: 'proj-1',
      sandbox: 'test',
      directory: '/home/user/worktrees/feature',
      names: ['LOOP_TOKEN'],
    }])
    const createCall = runtime.getCreateSandboxCalls()[0][2]
    expect(createCall?.secrets).toEqual([{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }])
    expect(createCall?.secretEnv).toEqual({ LOOP_TOKEN: SECRET_VALUE })
    expect(JSON.stringify(createCall?.secrets)).not.toContain(SECRET_VALUE)
    expect(JSON.stringify(createCall?.networkAllow)).not.toContain(SECRET_VALUE)
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(SECRET_VALUE)
  })

  test('a per-loop definition replaces a config definition of the same env', async () => {
    setEnv('LOOP_TOKEN', 'host-value')
    sandboxSecretProviders().set(PROVIDER_ID, () => ({ LOOP_TOKEN: SECRET_VALUE }))
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const manager = createSandboxManager(
      runtime,
      makeConfig(loopOverrides(PROVIDER_ID), {
        network: { secrets: [{ env: 'LOOP_TOKEN', hosts: ['config.example.com'] }] },
      }),
      logger,
    )

    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0][2]
    expect(createCall?.secrets).toEqual([{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }])
    expect(createCall?.secretEnv).toEqual({ LOOP_TOKEN: SECRET_VALUE })
  })

  test('per-loop secrets alone never restrict egress', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => ({ LOOP_TOKEN: SECRET_VALUE }))
    const runtime = createMockSandboxRuntime()
    const manager = createSandboxManager(runtime, makeConfig(loopOverrides(PROVIDER_ID)), createMockLogger())

    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0][2]
    expect(createCall?.restrictEgress).toBe(false)
    expect(createCall?.networkAllow).toEqual([])
  })

  test('per-loop secret hosts join a configured allow-list', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => ({ LOOP_TOKEN: SECRET_VALUE }))
    const runtime = createMockSandboxRuntime()
    const manager = createSandboxManager(
      runtime,
      makeConfig(loopOverrides(PROVIDER_ID), { network: { allow: ['pypi.org'] } }),
      createMockLogger(),
    )

    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0][2]
    expect(createCall?.restrictEgress).toBe(true)
    expect(createCall?.networkAllow).toEqual(['pypi.org', 'api.example.com'])
  })

  test('rejects a loop whose provider is not registered before creating anything', async () => {
    const runtime = createMockSandboxRuntime()
    const manager = createSandboxManager(runtime, makeConfig(loopOverrides('missing-provider')), createMockLogger())

    await expect(manager.start('test', '/home/user/worktrees/feature')).rejects.toThrow(
      'Sandbox secret provider "missing-provider" is not registered; the plugin that supplies these secrets must be loaded in this OpenCode process',
    )
    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
  })

  test('rejects a loop whose provider omits a value before creating anything', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => ({}))
    const runtime = createMockSandboxRuntime()
    const manager = createSandboxManager(runtime, makeConfig(loopOverrides(PROVIDER_ID)), createMockLogger())

    await expect(manager.start('test', '/home/user/worktrees/feature')).rejects.toThrow(
      'Sandbox secret provider "loop-secret-provider" returned no value for LOOP_TOKEN',
    )
    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
  })

  test('adopting a stopped loop sandbox refreshes secrets and then starts it with the values', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => ({ LOOP_TOKEN: SECRET_VALUE }))
    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'stopped')
    const manager = createSandboxManager(runtime, makeConfig(loopOverrides(PROVIDER_ID)), createMockLogger())

    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
    expect(runtime.getRefreshSecretCalls()).toEqual([
      ['forge-test', [{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }], { LOOP_TOKEN: SECRET_VALUE }],
    ])
    expect(runtime.getStartSandboxCalls()).toEqual([['forge-test', { LOOP_TOKEN: SECRET_VALUE }]])
  })

  test('a converged running loop sandbox skips the provider until it reports stopped', async () => {
    const provider = vi.fn(() => ({ LOOP_TOKEN: SECRET_VALUE }))
    sandboxSecretProviders().set(PROVIDER_ID, provider)
    vi.useFakeTimers()
    try {
      const runtime = createMockSandboxRuntime()
      runtime.setSandboxState('forge-test', 'running')
      const manager = createSandboxManager(runtime, makeConfig(loopOverrides(PROVIDER_ID)), createMockLogger())

      await manager.start('test', '/home/user/worktrees/feature')
      expect(provider).toHaveBeenCalledTimes(1)
      expect(runtime.getRefreshSecretCalls()).toHaveLength(1)
      expect(runtime.getStartSandboxCalls()).toHaveLength(0)

      vi.advanceTimersByTime(3_000)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')
      vi.advanceTimersByTime(3_000)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')
      expect(provider).toHaveBeenCalledTimes(1)

      runtime.setSandboxState('forge-test', 'stopped')
      vi.advanceTimersByTime(3_000)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')

      expect(provider).toHaveBeenCalledTimes(2)
      expect(runtime.getRefreshSecretCalls()).toHaveLength(1)
      expect(runtime.getStartSandboxCalls()).toEqual([['forge-test', { LOOP_TOKEN: SECRET_VALUE }]])
    } finally {
      vi.useRealTimers()
    }
  })

  test('a stopped loop sandbox without provider values is left for msb exec to start', async () => {
    setEnv('LOOP_TOKEN', 'host-value')
    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'stopped')
    const manager = createSandboxManager(runtime, makeConfig(loopOverrides()), createMockLogger())

    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getStartSandboxCalls()).toHaveLength(0)
    expect(runtime.getRefreshSecretCalls()).toHaveLength(1)
  })

  test('per-loop secrets without a provider read their value from the host environment', async () => {
    setEnv('LOOP_TOKEN', 'host-value')
    const runtime = createMockSandboxRuntime()
    const manager = createSandboxManager(runtime, makeConfig(loopOverrides()), createMockLogger())

    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0][2]
    expect(createCall?.secrets).toEqual([{ env: 'LOOP_TOKEN', hosts: ['api.example.com'] }])
    expect(createCall?.secretEnv).toBeUndefined()
  })

  test('per-loop secrets without a provider are skipped and warned once when the host variable is unset', async () => {
    setEnv('LOOP_TOKEN', undefined)
    vi.useFakeTimers()
    try {
      const runtime = createMockSandboxRuntime()
      runtime.setSandboxState('forge-test', 'stopped')
      const logger = createMockLogger()
      const manager = createSandboxManager(runtime, makeConfig(loopOverrides()), logger)

      await manager.ensureRunning('test', '/home/user/worktrees/feature')
      vi.advanceTimersByTime(3_000)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')

      expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
      expect(runtime.getRefreshSecretCalls()).toHaveLength(0)
      expect(runtime.getStartSandboxCalls()).toHaveLength(0)
      const warnings = logger.log.mock.calls.filter((call) => String(call[0]).includes('LOOP_TOKEN'))
      expect(warnings).toHaveLength(1)
      expect(String(warnings[0][0])).toContain('host variable is not set')
    } finally {
      vi.useRealTimers()
    }
  })
})
