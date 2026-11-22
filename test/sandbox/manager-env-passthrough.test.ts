import { describe, test, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSandboxManager, resolveSandboxEnvVarSources, type SandboxManagerConfig } from '../../src/sandbox/manager'
import type { SecretRefreshResult } from '../../src/sandbox/msb'
import { createMockSandboxRuntime } from '../helpers/sandbox-mocks'
import { createMockLogger } from '../helpers/logger'

describe('SandboxManager create-time env and secrets', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const tempDirs: string[] = []

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    Object.keys(savedEnv).forEach((k) => delete savedEnv[k])
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function setEnv(name: string, value: string | undefined) {
    if (!(name in savedEnv)) {
      savedEnv[name] = process.env[name]
    }
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }

  function writeSecretFile(name: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-secret-file-'))
    tempDirs.push(dir)
    const path = join(dir, name)
    writeFileSync(path, content)
    return path
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

  test('start forwards an extended secret definition to createSandbox unchanged', async () => {
    setEnv('FORGE_TEST_LAN', 'v')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        secrets: [
          {
            env: 'FORGE_TEST_LAN',
            hosts: [' ai2.lab ', 'second.example'],
            substitution: { headers: true, headerFields: ['authorization'], query: true, body: true },
            passthrough: ['*.x.org'],
            violationAction: 'block-and-log',
            requireTlsIdentity: false,
          },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()[0][2]?.secrets).toEqual([
      {
        env: 'FORGE_TEST_LAN',
        hosts: ['ai2.lab', 'second.example'],
        substitution: { headers: true, headerFields: ['authorization'], query: true, body: true },
        passthrough: ['*.x.org'],
        violationAction: 'block-and-log',
        requireTlsIdentity: false,
      },
    ])
  })

  test('start skips a rejected secret definition and logs its reason', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        secrets: [
          {
            env: 'FORGE_TEST_HEADERS',
            hosts: ['api.example.com'],
            substitution: { headers: false, headerFields: ['authorization'] },
          },
          { env: 'FORGE_TEST_PASSTHROUGH', hosts: ['api.example.com'], passthrough: ['bad,entry'] },
          { env: 'FORGE_TEST_ACTION', hosts: ['api.example.com'], violationAction: 'nope' as never },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()[0][2]?.secrets).toEqual([])
    expect(logger.log).toHaveBeenCalledWith(
      'Sandbox: skipping secret FORGE_TEST_HEADERS: substitution.headerFields requires substitution.headers',
    )
    expect(logger.log).toHaveBeenCalledWith(
      'Sandbox: skipping secret FORGE_TEST_PASSTHROUGH: substitution.headerFields and passthrough entries must not contain whitespace, commas, @, or brackets',
    )
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping secret FORGE_TEST_ACTION: invalid definition')
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
    expect(createCall[2]?.env).toEqual([])
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

  test('adopting a stopped sandbox through ensureRunning refreshes secrets exactly once across repeated calls past the TTL', async () => {
    setEnv('FORGE_TEST_SECRET', 'v')
    vi.useFakeTimers()
    try {
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

      vi.advanceTimersByTime(3_000)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')
      vi.advanceTimersByTime(3_000)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')

      expect(runtime.getRefreshSecretCalls()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
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

  test('a failed secret refresh rejects the adoption and is retried on the next attempt', async () => {
    setEnv('FORGE_TEST_SECRET', 'v')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    const refresh = vi.fn(async (): Promise<SecretRefreshResult> => ({
      ok: false,
      reason: 'msb refused the change',
    }))
    runtime.refreshSandboxSecrets = refresh
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_SECRET', hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await expect(manager.start('test', '/home/user/worktrees/feature')).rejects.toThrow(
      'Failed to refresh secrets for sandbox forge-test: msb refused the change; refusing to adopt',
    )
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(logger.log).toHaveBeenCalledWith(
      'Sandbox: failed to refresh secrets for forge-test: msb refused the change',
    )
    expect(manager.isActive('test')).toBe(false)

    refresh.mockResolvedValue({ ok: true })
    await expect(manager.start('test', '/home/user/worktrees/feature')).resolves.toEqual({
      containerName: 'forge-test',
    })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(manager.isActive('test')).toBe(true)
  })

  test('a failed secret refresh on the ensureRunning adopt path rejects and can be retried', async () => {
    setEnv('FORGE_TEST_SECRET', 'v')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'stopped')
    const refresh = vi.fn(async (): Promise<SecretRefreshResult> => ({
      ok: false,
      reason: 'msb refused the change',
    }))
    runtime.refreshSandboxSecrets = refresh
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_SECRET', hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await expect(manager.ensureRunning('test', '/home/user/worktrees/feature')).rejects.toThrow(/Failed to refresh secrets/)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(manager.isActive('test')).toBe(false)

    refresh.mockResolvedValue({ ok: true })
    await expect(manager.ensureRunning('test', '/home/user/worktrees/feature')).resolves.toBe('forge-test')
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  test('adopting an existing sandbox with no secrets configured never refreshes', async () => {
    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'stopped')
    const logger = createMockLogger()
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.ensureRunning('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
    expect(runtime.getRefreshSecretCalls()).toHaveLength(0)
  })

  test('warns at most once per missing secret host variable across repeated calls', async () => {
    setEnv('FORGE_TEST_UNSET', undefined)
    vi.useFakeTimers()
    try {
      const runtime = createMockSandboxRuntime()
      runtime.setSandboxState('forge-test', 'stopped')
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        network: { secrets: [{ env: 'FORGE_TEST_UNSET', hosts: ['api.example.com'] }] },
      }

      const manager = createSandboxManager(runtime, config, logger)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')
      vi.advanceTimersByTime(3_000)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')
      vi.advanceTimersByTime(3_000)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')

      const warnings = logger.log.mock.calls.filter((c) => String(c[0]).includes('FORGE_TEST_UNSET'))
      expect(warnings).toHaveLength(1)
      expect(String(warnings[0][0])).toContain('sandboxed shell commands will fail')
      expect(String(warnings[0][0])).toContain('sandbox.network.secrets')
    } finally {
      vi.useRealTimers()
    }
  })

  test('adopting an existing sandbox warns that new secret hosts may be unreachable until recreation', async () => {
    setEnv('FORGE_TEST_SECRET', 'v')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_SECRET', hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getRefreshSecretCalls()).toHaveLength(1)
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('may be unreachable'))
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('recreate the sandbox'))
  })

  test('stop clears the convergence so a recreated sandbox converges again', async () => {
    setEnv('FORGE_TEST_SECRET', 'v')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_SECRET', hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')
    expect(runtime.getRefreshSecretCalls()).toHaveLength(1)

    await manager.stop('test')

    runtime.setSandboxState('forge-test', 'stopped')
    await manager.start('test', '/home/user/worktrees/feature')
    expect(runtime.getRefreshSecretCalls()).toHaveLength(2)
  })

  test('cleanupOrphans clears the convergence so a recreated sandbox converges again', async () => {
    setEnv('FORGE_TEST_SECRET', 'v')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    runtime.setSandboxes(['forge-test'])
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_SECRET', hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')
    expect(runtime.getRefreshSecretCalls()).toHaveLength(1)

    await manager.cleanupOrphans()
    expect(manager.isActive('test')).toBe(false)

    runtime.setSandboxState('forge-test', 'stopped')
    await manager.start('test', '/home/user/worktrees/feature')
    expect(runtime.getRefreshSecretCalls()).toHaveLength(2)
  })

  test('reads a configured secret from a file and passes the value only in the msb environment', async () => {
    setEnv('FORGE_TEST_FILE_SECRET', undefined)
    const file = writeSecretFile('token', '  file-secret-value\n')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_FILE_SECRET', file, hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.secrets).toEqual([
      { env: 'FORGE_TEST_FILE_SECRET', file, hosts: ['api.example.com'] },
    ])
    expect(createCall[2]?.secretEnv).toEqual({ FORGE_TEST_FILE_SECRET: 'file-secret-value' })
    expect(JSON.stringify(createCall[2]?.secrets)).not.toContain('file-secret-value')
    expect(JSON.stringify(createCall[2]?.env)).not.toContain('file-secret-value')
    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('FORGE_TEST_FILE_SECRET'))
  })

  test('skips a configured file secret that cannot be read and names the path', async () => {
    setEnv('FORGE_TEST_MISSING_FILE', undefined)
    const dir = mkdtempSync(join(tmpdir(), 'forge-secret-file-'))
    tempDirs.push(dir)
    const file = join(dir, 'missing-token')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_MISSING_FILE', file, hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.secrets).toEqual([])
    expect(createCall[2]?.secretEnv).toBeUndefined()
    expect(logger.log).toHaveBeenCalledWith(
      `Sandbox: skipping secret FORGE_TEST_MISSING_FILE: could not read ${file}: ENOENT: no such file or directory, open '${file}'`,
    )
  })

  test('skips a configured file secret whose file is empty', async () => {
    setEnv('FORGE_TEST_EMPTY_FILE', undefined)
    const file = writeSecretFile('empty-token', '  \n')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_EMPTY_FILE', file, hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.secrets).toEqual([])
    expect(createCall[2]?.secretEnv).toBeUndefined()
    expect(logger.log).toHaveBeenCalledWith(
      `Sandbox: skipping secret FORGE_TEST_EMPTY_FILE: ${file} is empty`,
    )
  })

  test('logs a file secret failure once per reason and again after the file recovers', async () => {
    setEnv('FORGE_TEST_FLAKY_FILE', undefined)
    const file = writeSecretFile('flaky-token', '')
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_FLAKY_FILE', file, hosts: ['api.example.com'] }] },
    }
    const manager = createSandboxManager(runtime, config, logger)
    const fileLogs = () => vi.mocked(logger.log).mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('Sandbox: skipping secret FORGE_TEST_FLAKY_FILE'))

    await manager.start('a', '/home/user/worktrees/a')
    await manager.start('b', '/home/user/worktrees/b')
    expect(fileLogs()).toEqual([`Sandbox: skipping secret FORGE_TEST_FLAKY_FILE: ${file} is empty`])

    rmSync(file)
    await manager.start('c', '/home/user/worktrees/c')
    expect(fileLogs()).toHaveLength(2)

    writeFileSync(file, 'value\n')
    await manager.start('d', '/home/user/worktrees/d')
    writeFileSync(file, '')
    await manager.start('e', '/home/user/worktrees/e')
    expect(fileLogs()).toHaveLength(3)
  })

  test('start passes the vars of a bound file secret as create vars, not in the environment', async () => {
    setEnv('FORGE_TEST_VARS_TOKEN', undefined)
    const file = writeSecretFile('gitea-token', 'gitea-secret-value\n')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        secrets: [
          {
            env: 'FORGE_TEST_VARS_TOKEN',
            file,
            hosts: ['git.example.com'],
            vars: { GITEA_INSTANCE_URL: 'https://git.example.com' },
          },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual([])
    expect(createCall[2]?.vars).toEqual({ GITEA_INSTANCE_URL: 'https://git.example.com' })
    expect(createCall[2]?.secretEnv).toEqual({ FORGE_TEST_VARS_TOKEN: 'gitea-secret-value' })
    expect(JSON.stringify(createCall[2]?.secretEnv)).not.toContain('https://git.example.com')
  })

  test('start skips a passthrough env name matching a secret var and passes the var separately', async () => {
    setEnv('FORGE_TEST_VARS_SECRET', 'token-value')
    setEnv('GITEA_INSTANCE_URL', 'from-passthrough')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        env: ['GITEA_INSTANCE_URL'],
        secrets: [
          {
            env: 'FORGE_TEST_VARS_SECRET',
            hosts: ['git.example.com'],
            vars: { GITEA_INSTANCE_URL: 'https://git.example.com' },
          },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual([])
    expect(createCall[2]?.vars).toEqual({ GITEA_INSTANCE_URL: 'https://git.example.com' })
    expect(createCall[2]?.secretEnv).toBeUndefined()
    expect(JSON.stringify(createCall[2]?.env)).not.toContain('from-passthrough')
  })

  test('start skips a passthrough env name naming a bound secret or a secret var', async () => {
    setEnv('FORGE_TEST_ENV_SECRET', 'host-secret-value')
    setEnv('FORGE_TEST_ENV_SECRET_VAR_KEY', 'host-var-value')
    setEnv('FORGE_TEST_ENV_PASSTHROUGH', 'host-passthrough-value')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        env: ['FORGE_TEST_ENV_SECRET', 'FORGE_TEST_ENV_SECRET_VAR_KEY', 'FORGE_TEST_ENV_PASSTHROUGH'],
        secrets: [
          {
            env: 'FORGE_TEST_ENV_SECRET',
            hosts: ['api.example.com'],
            vars: { FORGE_TEST_ENV_SECRET_VAR_KEY: 'from-secret-var' },
          },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual(['FORGE_TEST_ENV_PASSTHROUGH'])
    expect(createCall[2]?.vars).toEqual({ FORGE_TEST_ENV_SECRET_VAR_KEY: 'from-secret-var' })
    expect(createCall[2]?.secretEnv).toBeUndefined()
    expect(JSON.stringify(createCall[2]?.env)).not.toContain('host-secret-value')
    expect(JSON.stringify(createCall[2]?.env)).not.toContain('host-var-value')
  })

  test('a var naming another bound secret is skipped', async () => {
    setEnv('FORGE_TEST_VARS_A', 'real-a')
    setEnv('FORGE_TEST_VARS_B', 'real-b')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        secrets: [
          { env: 'FORGE_TEST_VARS_A', hosts: ['a.example.com'], vars: { FORGE_TEST_VARS_B: 'leaked' } },
          { env: 'FORGE_TEST_VARS_B', hosts: ['b.example.com'] },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual([])
    expect(createCall[2]?.vars).toBeUndefined()
    expect(createCall[2]?.secretEnv).toBeUndefined()
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping var FORGE_TEST_VARS_B: it names a bound secret')
  })

  test('a secret skipped for a missing host variable contributes no vars', async () => {
    setEnv('FORGE_TEST_VARS_UNSET', undefined)

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        secrets: [
          {
            env: 'FORGE_TEST_VARS_UNSET',
            hosts: ['git.example.com'],
            vars: { GITEA_INSTANCE_URL: 'https://git.example.com' },
          },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual([])
    expect(createCall[2]?.vars).toBeUndefined()
    expect(createCall[2]?.secretEnv).toBeUndefined()
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('FORGE_TEST_VARS_UNSET'))
  })

  test('skips a per-loop secret that declares vars', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      resolveOverrides: () => ({
        secrets: [
          {
            env: 'FORGE_TEST_LOOP_VARS',
            hosts: ['api.example.com'],
            vars: { INSTANCE_URL: 'https://api.example.com' },
          },
        ],
      }),
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.secrets).toEqual([])
    expect(createCall[2]?.secretEnv).toBeUndefined()
    expect(logger.log).toHaveBeenCalledWith(
      'Sandbox: skipping secret FORGE_TEST_LOOP_VARS: vars is only supported in sandbox.network.secrets',
    )
  })

  test('adopting a stopped sandbox starts it with the file secret value', async () => {
    setEnv('FORGE_TEST_FILE_SECRET', undefined)
    const file = writeSecretFile('token', 'file-secret-value\n')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'stopped')
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: { secrets: [{ env: 'FORGE_TEST_FILE_SECRET', file, hosts: ['api.example.com'] }] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
    expect(runtime.getRefreshSecretCalls()).toEqual([
      ['forge-test', [{ env: 'FORGE_TEST_FILE_SECRET', file, hosts: ['api.example.com'] }], { FORGE_TEST_FILE_SECRET: 'file-secret-value' }],
    ])
    expect(runtime.getStartSandboxCalls()).toEqual([
      ['forge-test', { FORGE_TEST_FILE_SECRET: 'file-secret-value' }],
    ])
  })

  test('skips a per-loop secret that reads its value from a file', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      resolveOverrides: () => ({
        secrets: [{ env: 'FORGE_TEST_LOOP_FILE', file: '/run/secrets/token', hosts: ['api.example.com'] }],
      }),
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.secrets).toEqual([])
    expect(createCall[2]?.secretEnv).toBeUndefined()
    expect(logger.log).toHaveBeenCalledWith(
      'Sandbox: skipping secret FORGE_TEST_LOOP_FILE: file is only supported in sandbox.network.secrets',
    )
  })

  function unappliedVarWarnings(logger: ReturnType<typeof createMockLogger>): string[] {
    return logger.log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('are not applied to existing sandbox'))
  }

  function varsConfig(vars: Record<string, string>): SandboxManagerConfig {
    return {
      image: 'oc-forge-sandbox:latest',
      network: {
        secrets: [
          { env: 'FORGE_TEST_ADOPT_VARS', hosts: ['git.example.com'], vars },
        ],
      },
    }
  }

  test('adopting an existing sandbox warns when a configured var is missing from its env', async () => {
    setEnv('FORGE_TEST_ADOPT_VARS', 'token-value')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    runtime.setSandboxEnv('forge-test', { UNRELATED: 'x' })
    const logger = createMockLogger()

    const manager = createSandboxManager(
      runtime,
      varsConfig({ GITEA_INSTANCE_URL: 'https://git.example.com' }),
      logger,
    )
    await manager.start('test', '/home/user/worktrees/feature')

    const warnings = unappliedVarWarnings(logger)
    expect(warnings).toEqual([
      'Sandbox: vars GITEA_INSTANCE_URL are not applied to existing sandbox forge-test: vars are set only when a sandbox is created; remove it with `msb rm --force forge-test` so it is recreated',
    ])
    expect(warnings[0]).not.toContain('https://git.example.com')
    expect(warnings[0]).not.toContain('token-value')
  })

  test('adopting an existing sandbox warns when a configured var differs from its env', async () => {
    setEnv('FORGE_TEST_ADOPT_VARS', 'token-value')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    runtime.setSandboxEnv('forge-test', { GITEA_INSTANCE_URL: 'https://old.example.com' })
    const logger = createMockLogger()

    const manager = createSandboxManager(
      runtime,
      varsConfig({ GITEA_INSTANCE_URL: 'https://git.example.com' }),
      logger,
    )
    await manager.start('test', '/home/user/worktrees/feature')

    expect(unappliedVarWarnings(logger)).toHaveLength(1)
    expect(unappliedVarWarnings(logger)[0]).toContain('GITEA_INSTANCE_URL')
  })

  test('adopting an existing sandbox whose env matches the configured vars does not warn', async () => {
    setEnv('FORGE_TEST_ADOPT_VARS', 'token-value')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    runtime.setSandboxEnv('forge-test', {
      GITEA_INSTANCE_URL: 'https://git.example.com',
      UNRELATED: 'x',
    })
    const logger = createMockLogger()

    const manager = createSandboxManager(
      runtime,
      varsConfig({ GITEA_INSTANCE_URL: 'https://git.example.com' }),
      logger,
    )
    await manager.start('test', '/home/user/worktrees/feature')

    expect(unappliedVarWarnings(logger)).toEqual([])
  })

  test('adopting an existing sandbox whose env cannot be read does not warn', async () => {
    setEnv('FORGE_TEST_ADOPT_VARS', 'token-value')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    runtime.setSandboxEnv('forge-test', null)
    const logger = createMockLogger()

    const manager = createSandboxManager(
      runtime,
      varsConfig({ GITEA_INSTANCE_URL: 'https://git.example.com' }),
      logger,
    )
    await manager.start('test', '/home/user/worktrees/feature')

    expect(unappliedVarWarnings(logger)).toEqual([])
  })

  test('warns at most once for the same unapplied vars across repeated adoption', async () => {
    setEnv('FORGE_TEST_ADOPT_VARS', 'token-value')
    vi.useFakeTimers()
    try {
      const runtime = createMockSandboxRuntime()
      runtime.setSandboxState('forge-test', 'stopped')
      runtime.setSandboxEnv('forge-test', {})
      const logger = createMockLogger()

      const manager = createSandboxManager(
        runtime,
        varsConfig({ GITEA_INSTANCE_URL: 'https://git.example.com' }),
        logger,
      )
      await manager.ensureRunning('test', '/home/user/worktrees/feature')
      vi.advanceTimersByTime(3_000)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')
      vi.advanceTimersByTime(3_000)
      await manager.ensureRunning('test', '/home/user/worktrees/feature')

      expect(unappliedVarWarnings(logger)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('warns again when an already-warned var changes value', async () => {
    setEnv('FORGE_TEST_ADOPT_VARS', 'token-value')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    runtime.setSandboxEnv('forge-test', {})
    const logger = createMockLogger()
    const config = varsConfig({ GITEA_INSTANCE_URL: 'https://git.example.com' })
    const secret = config.network?.secrets?.[0]
    if (!secret) throw new Error('missing secret fixture')

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')
    secret.vars = { GITEA_INSTANCE_URL: 'https://other.example.com' }
    await manager.start('test', '/home/user/worktrees/feature')

    expect(unappliedVarWarnings(logger)).toHaveLength(2)
    expect(JSON.stringify(unappliedVarWarnings(logger))).not.toContain('example.com')
  })

  test('warns again when vars are removed from config and later restored', async () => {
    setEnv('FORGE_TEST_ADOPT_VARS', 'token-value')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    runtime.setSandboxEnv('forge-test', {})
    const logger = createMockLogger()
    const config = varsConfig({ GITEA_INSTANCE_URL: 'https://git.example.com' })
    const secret = config.network?.secrets?.[0]
    if (!secret) throw new Error('missing secret fixture')

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')
    delete secret.vars
    await manager.start('test', '/home/user/worktrees/feature')
    secret.vars = { GITEA_INSTANCE_URL: 'https://git.example.com' }
    await manager.start('test', '/home/user/worktrees/feature')

    expect(unappliedVarWarnings(logger)).toHaveLength(2)
  })

  test('warns again when a sandbox that matched drifts back to the same unapplied vars', async () => {
    setEnv('FORGE_TEST_ADOPT_VARS', 'token-value')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    runtime.setSandboxEnv('forge-test', {})
    const logger = createMockLogger()
    const manager = createSandboxManager(
      runtime,
      varsConfig({ GITEA_INSTANCE_URL: 'https://git.example.com' }),
      logger,
    )

    await manager.start('test', '/home/user/worktrees/feature')
    runtime.setSandboxEnv('forge-test', { GITEA_INSTANCE_URL: 'https://git.example.com' })
    await manager.start('test', '/home/user/worktrees/feature')
    runtime.setSandboxEnv('forge-test', {})
    await manager.start('test', '/home/user/worktrees/feature')

    expect(unappliedVarWarnings(logger)).toHaveLength(2)
  })

  test('warns again when an externally recreated sandbox drifts to the same unapplied vars', async () => {
    setEnv('FORGE_TEST_ADOPT_VARS', 'token-value')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    runtime.setSandboxEnv('forge-test', {})
    const logger = createMockLogger()

    const manager = createSandboxManager(
      runtime,
      varsConfig({ GITEA_INSTANCE_URL: 'https://git.example.com' }),
      logger,
    )
    await manager.start('test', '/home/user/worktrees/feature')
    expect(unappliedVarWarnings(logger)).toHaveLength(1)

    runtime.setSandboxState('forge-test', 'missing')
    await manager.start('test', '/home/user/worktrees/feature')
    expect(runtime.getCreateSandboxCalls()).toHaveLength(1)
    expect(runtime.getCreateSandboxCalls()[0][2]?.vars).toEqual({
      GITEA_INSTANCE_URL: 'https://git.example.com',
    })

    runtime.setSandboxState('forge-test', 'stopped')
    runtime.setSandboxEnv('forge-test', {})
    await manager.start('test', '/home/user/worktrees/feature')

    expect(unappliedVarWarnings(logger)).toHaveLength(2)
  })

  test('start forwards network vars and env-file values as bare names with values only in the runner env', async () => {
    const file = writeSecretFile('review-token', '  review-token-value\n')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        vars: { REVIEW_SERVER_URL: 'https://review.example.com' },
        envFiles: { REVIEW_TOKEN: file },
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual(['REVIEW_SERVER_URL', 'REVIEW_TOKEN'])
    expect(createCall[2]?.secretEnv).toEqual({
      REVIEW_SERVER_URL: 'https://review.example.com',
      REVIEW_TOKEN: 'review-token-value',
    })
    expect(JSON.stringify(createCall[2]?.env)).not.toContain('review.example.com')
    expect(JSON.stringify(createCall[2]?.env)).not.toContain('review-token-value')
    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('REVIEW_'))
  })

  test('skips env-file names whose file is missing or empty and logs the reason', async () => {
    setEnv('FORGE_TEST_ENV_FILE_MISSING', 'host-fallback')
    const dir = mkdtempSync(join(tmpdir(), 'forge-env-file-'))
    tempDirs.push(dir)
    const empty = join(dir, 'empty')
    writeFileSync(empty, '  \n')
    const missing = join(dir, 'missing')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        env: ['FORGE_TEST_ENV_FILE_MISSING'],
        envFiles: { FORGE_TEST_ENV_FILE_MISSING: missing, FORGE_TEST_ENV_FILE_EMPTY: empty },
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual([])
    expect(createCall[2]?.secretEnv).toBeUndefined()
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining(`Sandbox: skipping env file FORGE_TEST_ENV_FILE_MISSING: could not read ${missing}:`),
    )
    expect(logger.log).toHaveBeenCalledWith(
      `Sandbox: skipping env file FORGE_TEST_ENV_FILE_EMPTY: ${empty} is empty`,
    )
  })

  test('prefers vars over envFiles over host passthrough for the same name and emits each name once', async () => {
    setEnv('FORGE_TEST_PRECEDENCE_VAR', 'from-host')
    setEnv('FORGE_TEST_PRECEDENCE_FILE', 'from-host')
    setEnv('FORGE_TEST_PRECEDENCE_HOST', 'from-host')
    const file = writeSecretFile('precedence-token', 'from-file\n')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        env: ['FORGE_TEST_PRECEDENCE_VAR', 'FORGE_TEST_PRECEDENCE_FILE', 'FORGE_TEST_PRECEDENCE_HOST'],
        vars: { FORGE_TEST_PRECEDENCE_VAR: 'from-var' },
        envFiles: {
          FORGE_TEST_PRECEDENCE_VAR: file,
          FORGE_TEST_PRECEDENCE_FILE: file,
        },
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual([
      'FORGE_TEST_PRECEDENCE_VAR',
      'FORGE_TEST_PRECEDENCE_FILE',
      'FORGE_TEST_PRECEDENCE_HOST',
    ])
    expect(createCall[2]?.secretEnv).toEqual({
      FORGE_TEST_PRECEDENCE_VAR: 'from-var',
      FORGE_TEST_PRECEDENCE_FILE: 'from-file',
    })
    expect(createCall[2]?.env?.filter((name) => name === 'FORGE_TEST_PRECEDENCE_VAR')).toHaveLength(1)
    expect(JSON.stringify(createCall[2]?.env)).not.toContain('from-')
  })

  test('a network var or env file naming a bound secret is skipped', async () => {
    const secretFile = writeSecretFile('bound-token', 'bound-secret-value\n')
    const varFile = writeSecretFile('var-token', 'var-file-value\n')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        vars: { FORGE_TEST_BOUND_VAR: 'literal-should-lose' },
        envFiles: { FORGE_TEST_BOUND_FILE: varFile },
        secrets: [
          { env: 'FORGE_TEST_BOUND_VAR', file: secretFile, hosts: ['api.example.com'] },
          { env: 'FORGE_TEST_BOUND_FILE', file: secretFile, hosts: ['api.example.com'] },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual([])
    expect(createCall[2]?.secretEnv).toEqual({
      FORGE_TEST_BOUND_VAR: 'bound-secret-value',
      FORGE_TEST_BOUND_FILE: 'bound-secret-value',
    })
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping var FORGE_TEST_BOUND_VAR: it names a bound secret')
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping env file FORGE_TEST_BOUND_FILE: it names a bound secret')
  })

  test('trims network var names and skips empty or invalid ones', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        vars: {
          ' FORGE_TEST_TRIMMED ': 'trimmed-value',
          '': 'empty-name-value',
          '1BAD': 'digit-first',
          'BAD-NAME': 'dash-name',
        },
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual(['FORGE_TEST_TRIMMED'])
    expect(createCall[2]?.secretEnv).toEqual({ FORGE_TEST_TRIMMED: 'trimmed-value' })
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping var with an empty name')
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Sandbox: skipping var 1BAD:'))
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Sandbox: skipping var BAD-NAME:'))
    expect(JSON.stringify(createCall[2]?.env)).not.toContain('trimmed-value')
  })

  test('sets a var named __proto__ as a real guest variable', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        vars: { ['__proto__']: 'proto-value' },
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(createCall[2]?.secretEnv ?? {}, '__proto__')?.value).toBe('proto-value')
  })

  test('adopting a stopped sandbox starts it with only the secret values, not network vars or env-file values', async () => {
    const networkFile = writeSecretFile('network-token', 'network-file-value\n')
    const secretFile = writeSecretFile('start-secret', 'start-secret-value\n')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'stopped')
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        vars: { REVIEW_SERVER_URL: 'https://review.example.com' },
        envFiles: { REVIEW_TOKEN: networkFile },
        secrets: [{ env: 'FORGE_TEST_START_SECRET', file: secretFile, hosts: ['api.example.com'] }],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
    expect(runtime.getStartSandboxCalls()).toEqual([
      ['forge-test', { FORGE_TEST_START_SECRET: 'start-secret-value' }],
    ])
  })

  test('adopting a stopped sandbox with only network vars or env files does not start it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-env-file-stopped-'))
    tempDirs.push(dir)
    const missing = join(dir, 'missing')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'stopped')
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        vars: { REVIEW_SERVER_URL: 'https://review.example.com' },
        envFiles: { REVIEW_TOKEN: missing },
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
    expect(runtime.getStartSandboxCalls()).toEqual([])
    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('could not read'))
  })

  test('a network var or env file naming a secret var is skipped and the secret var is kept', async () => {
    const secretFile = writeSecretFile('collision-secret', 'collision-secret-value\n')
    const file = writeSecretFile('collision-file', 'collision-file-value\n')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        vars: { FORGE_TEST_SECRET_VAR: 'literal-should-lose' },
        envFiles: { FORGE_TEST_SECRET_FILE_VAR: file },
        secrets: [
          {
            env: 'FORGE_TEST_COLLISION_SECRET',
            file: secretFile,
            hosts: ['api.example.com'],
            vars: {
              FORGE_TEST_SECRET_VAR: 'secret-var-value',
              FORGE_TEST_SECRET_FILE_VAR: 'secret-file-var-value',
            },
          },
        ],
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const createCall = runtime.getCreateSandboxCalls()[0]
    expect(createCall[2]?.env).toEqual([])
    expect(createCall[2]?.secretEnv).toEqual({
      FORGE_TEST_COLLISION_SECRET: 'collision-secret-value',
    })
    expect(createCall[2]?.vars).toEqual({
      FORGE_TEST_SECRET_VAR: 'secret-var-value',
      FORGE_TEST_SECRET_FILE_VAR: 'secret-file-var-value',
    })
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping var FORGE_TEST_SECRET_VAR: it names a bound secret')
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping env file FORGE_TEST_SECRET_FILE_VAR: it names a bound secret')
  })

  test('adopting a running sandbox does not reapply network vars or env files', async () => {
    const file = writeSecretFile('running-token', 'file-value\n')

    const runtime = createMockSandboxRuntime()
    runtime.setSandboxState('forge-test', 'running')
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      network: {
        vars: { REVIEW_SERVER_URL: 'https://review.example.com' },
        envFiles: { REVIEW_TOKEN: file },
      },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()).toHaveLength(0)
    expect(runtime.getStartSandboxCalls()).toEqual([])
    expect(runtime.getRefreshSecretCalls()).toEqual([])
  })
})

describe('resolveSandboxEnvVarSources', () => {
  test('orders vars before env files, trims names, and drops invalid or already-claimed names', () => {
    const logger = createMockLogger()
    const sources = resolveSandboxEnvVarSources(
      {
        vars: { ' A ': 'literal', '1BAD': 'x', '': 'y' },
        envFiles: { A: '/tmp/a', B: '/tmp/b', ' B ': '/tmp/c' },
      },
      new Set(),
      logger,
    )

    expect(sources).toEqual([
      { name: 'A', value: 'literal' },
      { name: 'B', file: '/tmp/b' },
    ])
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping var with an empty name')
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Sandbox: skipping var 1BAD:'))
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping env file A: already set by an earlier var')
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping env file B: already set by an earlier env file')
  })

  test('skips names bound by a secret', () => {
    const logger = createMockLogger()
    const sources = resolveSandboxEnvVarSources(
      { vars: { TOKEN: 'literal' }, envFiles: { TOKEN: '/tmp/token' } },
      new Set(['TOKEN']),
      logger,
    )

    expect(sources).toEqual([])
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping var TOKEN: it names a bound secret')
    expect(logger.log).toHaveBeenCalledWith('Sandbox: skipping env file TOKEN: it names a bound secret')
  })

  test('keeps an empty literal value', () => {
    const logger = createMockLogger()
    expect(resolveSandboxEnvVarSources({ vars: { EMPTY: '' } }, new Set(), logger)).toEqual([
      { name: 'EMPTY', value: '' },
    ])
  })
})
