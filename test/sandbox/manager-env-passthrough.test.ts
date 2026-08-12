import { describe, test, expect, afterEach, vi } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockLogger, createMockSandboxRuntime } from '../helpers/sandbox-mocks'

describe('SandboxManager create-time env and secrets', () => {
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

  test('start forwards only env names that are set on the host and logs the omissions', async () => {
    setEnv('FORGE_TEST_DEFINED', 'abc123')
    setEnv('FORGE_TEST_UNDEFINED', undefined)

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { env: ['FORGE_TEST_DEFINED', 'FORGE_TEST_UNDEFINED'] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual(['FORGE_TEST_DEFINED'])
    expect(createCall[2]?.env).not.toContain('FORGE_TEST_UNDEFINED')
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('FORGE_TEST_UNDEFINED'))
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('not set'))
  })

  test('start forwards configured secrets only when their host variable is set', async () => {
    setEnv('FORGE_TEST_SECRET', 's3cr3t-value')
    setEnv('FORGE_TEST_UNSET', undefined)

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        secrets: [
          { env: 'FORGE_TEST_SECRET', hosts: ['api.github.com'] },
          { env: 'FORGE_TEST_UNSET', hosts: ['api.github.com'] },
          { env: '', hosts: ['api.github.com'] },
          { env: 'FORGE_TEST_NO_HOSTS', hosts: [] },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.secrets).toEqual([{ env: 'FORGE_TEST_SECRET', hosts: ['api.github.com'] }])
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('FORGE_TEST_UNSET'))
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('not set'))
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('no allowed hosts'))
  })

  test('omits secrets with whitespace-only names or hosts and logs the accurate reason', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        secrets: [
          { env: '   ', hosts: ['api.github.com'] },
          { env: 'FORGE_TEST_WS_HOSTS', hosts: ['   '] },
          { env: 'FORGE_TEST_WS_HOSTS_2', hosts: ['api.example.com', '  '] },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.secrets).toEqual([])
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('missing env name'))
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('FORGE_TEST_WS_HOSTS'))
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('no allowed hosts'))
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('FORGE_TEST_WS_HOSTS_2'))
  })

  test('trims and forwards secret env names and hosts that are otherwise valid', async () => {
    setEnv('FORGE_TEST_PADDED', 'v')
    setEnv('FORGE_TEST_PADDED_HOSTS', 'v')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        secrets: [
          { env: ' FORGE_TEST_PADDED ', hosts: [' api.github.com '] },
          { env: 'FORGE_TEST_PADDED_HOSTS', hosts: [' *.githubusercontent.com '] },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.secrets).toEqual([
      { env: 'FORGE_TEST_PADDED', hosts: ['api.github.com'] },
      { env: 'FORGE_TEST_PADDED_HOSTS', hosts: ['*.githubusercontent.com'] },
    ])
    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('FORGE_TEST_PADDED'))
  })

  test('no credential value leaks into the create arguments', async () => {
    setEnv('FORGE_TEST_TOKEN', 'super-secret-value')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        env: ['FORGE_TEST_TOKEN'],
        secrets: [{ env: 'FORGE_TEST_TOKEN', hosts: ['api.example.com'] }],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual(['FORGE_TEST_TOKEN'])
    expect(createCall[2]?.secrets).toEqual([{ env: 'FORGE_TEST_TOKEN', hosts: ['api.example.com'] }])
    // Only names (bare `-e NAME`) and references (`ENV@HOST`) are forwarded, never values.
    expect(JSON.stringify(createCall)).not.toContain('super-secret-value')
    expect(JSON.stringify(createCall)).not.toContain('=')
  })

  test('with no network config, start forwards empty env and secrets lists', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual([])
    expect(createCall[2]?.secrets).toEqual([])
  })

  test('adopting an existing running sandbox refreshes secrets with the current filtered list', async () => {
    setEnv('FORGE_TEST_SECRET', 's3cr3t-value')
    setEnv('FORGE_TEST_ROTATED', 'rotated-value')
    setEnv('FORGE_TEST_UNSET', undefined)

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        secrets: [
          { env: 'FORGE_TEST_SECRET', hosts: ['api.github.com'] },
          { env: 'FORGE_TEST_ROTATED', hosts: ['api.github.com'] },
          { env: 'FORGE_TEST_UNSET', hosts: ['api.github.com'] },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
    const calls = runtime.getRefreshSecretCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('forge-test')
    expect(calls[0][1]).toEqual([
      { env: 'FORGE_TEST_SECRET', hosts: ['api.github.com'] },
      { env: 'FORGE_TEST_ROTATED', hosts: ['api.github.com'] },
    ])
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('FORGE_TEST_UNSET'))
  })

  test('adopting a stopped sandbox through ensureRunning refreshes secrets exactly once', async () => {
    setEnv('FORGE_TEST_SECRET', 'v')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'stopped')
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_SECRET', hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.ensureRunning('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
    expect(runtime.getRefreshSecretCalls()).toHaveLength(1)
    expect(runtime.getRefreshSecretCalls()[0][1]).toEqual([
      { env: 'FORGE_TEST_SECRET', hosts: ['api.example.com'] },
    ])
  })

  test('creating a new sandbox issues no refreshSandboxSecrets call', async () => {
    setEnv('FORGE_TEST_SECRET', 'v')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_SECRET', hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()).toHaveLength(1)
    expect(runtime.getRefreshSecretCalls()).toHaveLength(0)
  })

  test('a failed secret refresh is logged and does not block adopting the sandbox', async () => {
    setEnv('FORGE_TEST_SECRET', 'v')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    runtime.refreshSandboxSecrets = vi.fn(async () => false)
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_SECRET', hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await expect(manager.start('test', '/home/user/worktrees/feature')).resolves.toEqual({
      containerName: 'forge-test',
    })
    expect(runtime.refreshSandboxSecrets).toHaveBeenCalledTimes(1)
    expect(logger.log).toHaveBeenCalledWith('Sandbox: failed to refresh secrets for forge-test')
  })
})
