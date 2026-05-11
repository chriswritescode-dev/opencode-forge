import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock modules before imports
vi.mock('../../src/sandbox/docker', () => ({
  createDockerService: vi.fn(),
}))

const mockExec = vi.fn()
const mockContainerName = vi.fn()

// We'll import and test the manager factory directly after setup

describe('SandboxManager.provisionDependencies', () => {
  let tempDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    tempDir = mkdtempSync(join(tmpdir(), 'sandbox-provision-test-'))
  })

  it('runs pnpm install --prefer-offline --frozen-lockfile when pnpm-lock.yaml exists', async () => {
    const lockfile = join(tempDir, 'pnpm-lock.yaml')
    writeFileSync(lockfile, 'lockfile version: 9')

    // Create a minimal docker mock
    const docker = {
      checkDocker: vi.fn().mockResolvedValue(true),
      imageExists: vi.fn().mockResolvedValue(true),
      createContainer: vi.fn(),
      removeContainer: vi.fn(),
      exec: mockExec,
      execPipe: vi.fn(),
      isRunning: vi.fn().mockResolvedValue(false),
      containerName: mockContainerName.mockReturnValue('oc-forge-sandbox-test-loop'),
      listContainersByPrefix: vi.fn().mockResolvedValue([]),
    }

    // Import the real module (not mocked) to test actual implementation
    const { createSandboxManager } = await import('../../src/sandbox/manager')
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const manager = createSandboxManager(docker as any, { image: 'test' }, logger)

    // Create a fake container that's already running so start doesn't fail
    docker.isRunning.mockResolvedValue(true)

    // Start first (to register container)
    await manager.start('test-loop', tempDir)

    // Now call provisionDependencies
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

    await manager.provisionDependencies('test-loop', tempDir)

    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(mockExec).toHaveBeenCalledWith(
      'oc-forge-sandbox-test-loop',
      'pnpm install --prefer-offline --frozen-lockfile',
      { cwd: '/workspace', timeout: 10 * 60 * 1000 },
    )
  })

  it('skips provisioning when no pnpm-lock.yaml exists', async () => {
    // No lockfile created — temp dir is empty

    const docker = {
      checkDocker: vi.fn().mockResolvedValue(true),
      imageExists: vi.fn().mockResolvedValue(true),
      createContainer: vi.fn(),
      removeContainer: vi.fn(),
      exec: mockExec,
      execPipe: vi.fn(),
      isRunning: vi.fn().mockResolvedValue(false),
      containerName: mockContainerName.mockReturnValue('oc-forge-sandbox-test-loop'),
      listContainersByPrefix: vi.fn().mockResolvedValue([]),
    }

    const { createSandboxManager } = await import('../../src/sandbox/manager')
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const manager = createSandboxManager(docker as any, { image: 'test' }, logger)

    await manager.provisionDependencies('test-loop', tempDir)

    expect(mockExec).not.toHaveBeenCalled()
  })

  it('throws and surfaces stderr when install exits non-zero', async () => {
    const lockfile = join(tempDir, 'pnpm-lock.yaml')
    writeFileSync(lockfile, 'lockfile version: 9')

    const docker = {
      checkDocker: vi.fn().mockResolvedValue(true),
      imageExists: vi.fn().mockResolvedValue(true),
      createContainer: vi.fn(),
      removeContainer: vi.fn(),
      exec: mockExec,
      execPipe: vi.fn(),
      isRunning: vi.fn().mockResolvedValue(false),
      containerName: mockContainerName.mockReturnValue('oc-forge-sandbox-test-loop'),
      listContainersByPrefix: vi.fn().mockResolvedValue([]),
    }

    const { createSandboxManager } = await import('../../src/sandbox/manager')
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const manager = createSandboxManager(docker as any, { image: 'test' }, logger)

    await manager.start('test-loop', tempDir)

    // Mock exec to return non-zero exit code with stderr
    mockExec.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'ERR_PNPM_NO_OFFLINE_META_FOUND foo@1.0.0\nERR_PNPM_NO_OFFLINE_META_FOUND bar@2.0.0\nSome other error line',
    })

    await expect(manager.provisionDependencies('test-loop', tempDir)).rejects.toThrow(
      /pnpm install failed \(exit 1\)/,
    )

    expect(mockExec).toHaveBeenCalledWith(
      'oc-forge-sandbox-test-loop',
      'pnpm install --prefer-offline --frozen-lockfile',
      { cwd: '/workspace', timeout: 10 * 60 * 1000 },
    )
  })
})
