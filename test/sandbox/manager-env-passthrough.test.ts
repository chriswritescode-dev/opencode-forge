import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, readdirSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockLogger, createMockSandboxRuntime } from '../helpers/sandbox-mocks'

describe('SandboxManager env passthrough file lifecycle', () => {
  const tmpDirs: string[] = []
  const savedEnv: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true })
    }
    tmpDirs.length = 0
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    Object.keys(savedEnv).forEach((k) => delete savedEnv[k])
  })

  function createTempDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-env-passthrough-'))
    tmpDirs.push(dir)
    return dir
  }

  function setEnv(name: string, value: string | undefined) {
    if (!(name in savedEnv)) {
      savedEnv[name] = process.env[name]
    }
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }

  test('writes a 0600 env file after start, exposes it on the active entry, and deletes it on stop', async () => {
    setEnv('FORGE_TEST_TOKEN', 'abc123')
    setEnv('FORGE_TEST_EMPTY', undefined)
    const dataDir = createTempDataDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      dataDir,
      network: { env: ['FORGE_TEST_TOKEN', 'FORGE_TEST_EMPTY', 'FORGE_TEST_UNSET'] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const envFile = manager.getActive('test')?.envFile
    expect(envFile).toBeDefined()
    const expectedPath = join(dataDir, 'sandbox-env', 'forge-test.env')
    expect(envFile).toBe(expectedPath)

    expect(existsSync(expectedPath)).toBe(true)
    expect(readFileSync(expectedPath, 'utf-8')).toBe('FORGE_TEST_TOKEN=abc123\n')
    // Only the set variable is listed; unset/absent names are omitted.
    expect(readFileSync(expectedPath, 'utf-8')).not.toMatch(/FORGE_TEST_EMPTY/)
    expect(statSync(expectedPath).mode & 0o777).toBe(0o600)
    expect(runtime.getCreateSandboxCalls()[0][1]).toContainEqual({
      hostDir: join(dataDir, 'sandbox-env'),
      readOnly: true,
    })

    await manager.stop('test')

    expect(existsSync(expectedPath)).toBe(false)
  })

  test('with no network.env configured, no env file is created and envFile is undefined', async () => {
    setEnv('FORGE_TEST_TOKEN', 'abc123')
    const dataDir = createTempDataDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      dataDir,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(manager.getActive('test')?.envFile).toBeUndefined()
    expect(existsSync(join(dataDir, 'sandbox-env'))).toBe(false)
    expect(runtime.getCreateSandboxCalls()[0][1]).not.toContainEqual({
      hostDir: join(dataDir, 'sandbox-env'),
      readOnly: true,
    })
  })

  test('no sandbox-env directory is created when no listed variable is set', async () => {
    setEnv('FORGE_TEST_TOKEN', undefined)
    const dataDir = createTempDataDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      dataDir,
      network: { env: ['FORGE_TEST_TOKEN'] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    expect(manager.getActive('test')?.envFile).toBeUndefined()
    expect(existsSync(join(dataDir, 'sandbox-env'))).toBe(false)
  })

  test('stop deletes the env file even when it holds no sandbox-env dir entry', async () => {
    setEnv('FORGE_TEST_TOKEN', 'abc123')
    const dataDir = createTempDataDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      dataDir,
      network: { env: ['FORGE_TEST_TOKEN'] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')
    const envFile = manager.getActive('test')?.envFile!
    expect(existsSync(envFile)).toBe(true)

    // Simulate a stale active entry without a sandbox-env directory listing.
    await manager.stop('test')

    expect(existsSync(envFile)).toBe(false)
    expect(readdirSync(join(dataDir, 'sandbox-env'))).toHaveLength(0)
  })

  test('stop clears the active map entry even when the env file cannot be removed', async () => {
    setEnv('FORGE_TEST_TOKEN', 'abc123')
    const dataDir = createTempDataDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      dataDir,
      network: { env: ['FORGE_TEST_TOKEN'] },
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')
    const envFile = manager.getActive('test')?.envFile!
    expect(existsSync(envFile)).toBe(true)

    // Replace the env file with a non-empty directory so its deletion throws (filesystem access),
    // while the container removal itself succeeds.
    rmSync(envFile)
    mkdirSync(envFile)
    writeFileSync(join(envFile, 'block'), 'x')

    await expect(manager.stop('test')).resolves.toBeUndefined()

    // The container was removed and the stale in-memory entry is gone despite the env-file failure,
    // so no fail-closed retries are triggered for an already-removed container.
    expect(manager.getActive('test')).toBeNull()
  })
})
