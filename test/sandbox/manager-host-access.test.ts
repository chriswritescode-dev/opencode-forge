import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import type { DockerService } from '../../src/sandbox/docker'
import type { Logger } from '../../src/types'

function createMockLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

interface DockerServiceMock {
  checkDocker: () => Promise<boolean>
  imageExists: () => Promise<boolean>
  buildImage: () => Promise<void>
  createContainer: (name: string, projectDir: string, image: string, opts?: Record<string, unknown>) => Promise<void>
  removeContainer: () => Promise<void>
  exec: () => Promise<{ stdout: string; stderr: string; exitCode: number }>
  execPipe: () => Promise<{ stdout: string; stderr: string; exitCode: number }>
  isRunning: () => Promise<boolean>
  containerName: (worktreeName: string) => string
  listContainersByPrefix: () => Promise<string[]>
  getCreateContainerCalls: () => Array<[string, string, string, Record<string, unknown> | undefined]>
  setRunning: (name: string, running: boolean) => void
}

function createMockDockerService(): DockerServiceMock {
  const createContainerCalls: Array<[string, string, string, Record<string, unknown> | undefined]> = []
  let runningContainers = new Set<string>()

  return {
    checkDocker: async () => true,
    imageExists: async () => true,
    buildImage: async () => {},
    createContainer: async (name: string, projectDir: string, image: string, opts?: Record<string, unknown>) => {
      createContainerCalls.push([name, projectDir, image, opts])
      runningContainers.add(name)
    },
    removeContainer: async () => {},
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    execPipe: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    isRunning: async () => false,
    containerName: (worktreeName: string) => `forge-${worktreeName}`,
    listContainersByPrefix: async () => [],
    getCreateContainerCalls: () => createContainerCalls,
    setRunning: (name: string, running: boolean) => {
      if (running) runningContainers.add(name); else runningContainers.delete(name)
    },
  }
}

function getCreateContainerOpts(mock: DockerServiceMock): Record<string, unknown> | undefined {
  const calls = mock.getCreateContainerCalls()
  return calls.length > 0 ? calls[0][3] : undefined
}

describe('SandboxManager host access', () => {
  describe('addHosts / hostGateway', () => {
    test('default adds host.docker.internal:host-gateway', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.addHosts).toEqual(['host.docker.internal:host-gateway'])
    })

    test('empty addHosts when hostGateway is false', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        network: { hostGateway: false },
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.addHosts).toEqual([])
    })

    test('empty addHosts when hostGateway is true explicitly', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        network: { hostGateway: true },
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.addHosts).toEqual(['host.docker.internal:host-gateway'])
    })
  })

  describe('env passthrough', () => {
    let tmpDir: string
    const originalEnv = { ...process.env }

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'sandbox-env-'))
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
      process.env = { ...originalEnv }
    })

    test('writes env passthrough file and sets opts.envFile', async () => {
      process.env.TEST_VAR = 'hello'

      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        dataDir: tmpDir,
        network: { env: ['TEST_VAR'] },
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.envFile).toBeDefined()
      expect(typeof opts?.envFile).toBe('string')

      // File path should be under the dataDir sandbox-env directory
      expect(opts!.envFile as string).toMatch(/sandbox-env\/forge-test\.env$/)

      // File should be removed after create (cleaned up in finally block)
      expect(existsSync(opts!.envFile as string)).toBe(false)
    })

    test('no envFile when no matching env vars', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        dataDir: tmpDir,
        network: { env: ['UNDEFINED_VAR_12345'] },
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.envFile).toBeUndefined()
    })

    test('no envFile when env array is empty', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        dataDir: tmpDir,
        network: { env: [] },
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.envFile).toBeUndefined()
    })

    test('no envFile when no dataDir configured', async () => {
      process.env.TEST_VAR = 'hello'

      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        dataDir: undefined,
        network: { env: ['TEST_VAR'] },
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.envFile).toBeUndefined()
    })
  })

  describe('resolveUser', () => {
    test('sets user when resolveHostUser returns a value', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        resolveHostUser: () => '1000:1000',
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.user).toBe('1000:1000')
    })

    test('sets user when resolveHostUser returns different value', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        resolveHostUser: () => '1001:1002',
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.user).toBe('1001:1002')
    })

    test('user undefined when runAsHostUser is false', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        runAsHostUser: false,
        resolveHostUser: () => '1000:1000',
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.user).toBeUndefined()
    })

    test('user undefined when resolveHostUser returns undefined', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        resolveHostUser: () => undefined,
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
      await manager.start('test', '/home/user/worktrees/feature')

      const opts = getCreateContainerOpts(mockDocker)
      expect(opts?.user).toBeUndefined()
    })
  })
})
