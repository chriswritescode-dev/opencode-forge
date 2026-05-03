import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execSync } from 'child_process'
import { createSandboxManager } from '../src/sandbox/manager'
import type { DockerService } from '../src/sandbox/docker'
import type { Logger } from '../src/types'

function createMockLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

function createMockDockerService() {
  const removeContainerCalls: string[] = []
  const createContainerCalls: Array<[string, string, string, string[] | undefined]> = []
  let containers = ['oc-forge-sandbox-foo', 'oc-forge-sandbox-bar']
  let runningContainers = new Set<string>()
  let shouldDockerBeAvailable = true
  let shouldImageExist = true
  let shouldRemoveThrow = false

  const mock = {
    checkDocker: async () => shouldDockerBeAvailable,
    imageExists: async () => shouldImageExist,
    buildImage: async () => {},
    createContainer: async (name: string, projectDir: string, image: string, extraMounts?: string[]) => {
      createContainerCalls.push([name, projectDir, image, extraMounts])
      runningContainers.add(name)
    },
    removeContainer: async (name: string) => {
      removeContainerCalls.push(name)
      if (shouldRemoveThrow) {
        throw new Error('Failed to remove container')
      }
    },
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    execPipe: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    isRunning: async (name: string) => runningContainers.has(name),
    containerName: (worktreeName: string) => `oc-forge-sandbox-${worktreeName}`,
    listContainersByPrefix: async (prefix: string) => {
      return containers.filter((name) => name.startsWith(prefix))
    },
    getRemoveContainerCalls: () => removeContainerCalls,
    getCreateContainerCalls: () => createContainerCalls,
    setContainers: (newContainers: string[]) => {
      containers = newContainers
    },
    setRunning: (name: string, running: boolean) => {
      if (running) {
        runningContainers.add(name)
      } else {
        runningContainers.delete(name)
      }
    },
    setDockerAvailable: (available: boolean) => {
      shouldDockerBeAvailable = available
    },
    setImageExists: (exists: boolean) => {
      shouldImageExist = exists
    },
    setRemoveThrow: (shouldThrow: boolean) => {
      shouldRemoveThrow = shouldThrow
    },
  }
  return mock
}

describe('SandboxManager', () => {
  describe('cleanupOrphans', () => {
    test('with no whitelist kills all containers', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      const removed = await manager.cleanupOrphans()

      expect(removed).toBe(2)
      const calls = mockDocker.getRemoveContainerCalls()
      expect(calls).toContain('oc-forge-sandbox-foo')
      expect(calls).toContain('oc-forge-sandbox-bar')
      expect(manager.isActive('foo')).toBe(false)
      expect(manager.isActive('bar')).toBe(false)
    })

    test('with whitelist preserves matching containers', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('foo', '/path/foo')

      const removed = await manager.cleanupOrphans(['foo'])

      expect(removed).toBe(1)
      const calls = mockDocker.getRemoveContainerCalls()
      expect(calls).toContain('oc-forge-sandbox-bar')
      expect(calls).not.toContain('oc-forge-sandbox-foo')
      expect(manager.isActive('foo')).toBe(true)
    })
  })

  describe('restore', () => {
    test('repopulates map when container is running', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      mockDocker.setRunning('oc-forge-sandbox-foo', true)
      const startedAt = new Date().toISOString()

      await manager.restore('foo', '/path/foo', startedAt)

      const createCalls = mockDocker.getCreateContainerCalls()
      expect(createCalls.length).toBe(0)
      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.containerName).toBe('oc-forge-sandbox-foo')
      expect(active?.projectDir).toBe('/path/foo')
    })

    test('repopulates map with original startedAt when provided', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      mockDocker.setRunning('oc-forge-sandbox-foo', true)
      const originalStartedAt = '2025-01-01T00:00:00.000Z'

      await manager.restore('foo', '/path/foo', originalStartedAt)

      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.startedAt).toBe(originalStartedAt)
    })

    test('starts new container when not running', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      mockDocker.setRunning('oc-forge-sandbox-foo', false)

      await manager.restore('foo', '/path/foo', new Date().toISOString())

      const createCalls = mockDocker.getCreateContainerCalls()
      expect(createCalls.length).toBe(1)
      expect(createCalls[0][0]).toBe('oc-forge-sandbox-foo')
      expect(createCalls[0][1]).toBe('/path/foo')
      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.containerName).toBe('oc-forge-sandbox-foo')
    })

    test('preserves startedAt when starting new container', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      mockDocker.setRunning('oc-forge-sandbox-foo', false)
      const originalStartedAt = '2025-01-01T00:00:00.000Z'

      await manager.restore('foo', '/path/foo', originalStartedAt)

      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.startedAt).toBe(originalStartedAt)
    })
  })

  describe('start', () => {
    test('throws when Docker is not available', async () => {
      const mockDocker = createMockDockerService()
      mockDocker.setDockerAvailable(false)
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await expect(() => manager.start('test', '/path')).toThrow('Docker is not available')
    })

    test('throws when image does not exist', async () => {
      const mockDocker = createMockDockerService()
      mockDocker.setImageExists(false)
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await expect(() => manager.start('test', '/path')).toThrow('not found')
    })

    test('returns early when container already running', async () => {
      const mockDocker = createMockDockerService()
      mockDocker.setRunning('oc-forge-sandbox-test', true)
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      const result = await manager.start('test', '/path')

      expect(mockDocker.getCreateContainerCalls().length).toBe(0)
      expect(result).toEqual({ containerName: 'oc-forge-sandbox-test' })
    })

    test('creates container and populates active map', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      const result = await manager.start('test', '/path')

      expect(mockDocker.getCreateContainerCalls().length).toBe(1)
      expect(manager.isActive('test')).toBe(true)
      const active = manager.getActive('test')
      expect(active).not.toBeNull()
      expect(active?.containerName).toBe('oc-forge-sandbox-test')
    })

    test('mounts linked worktree git metadata writable', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'sandbox-worktree-'))
      try {
        const worktreeDir = join(tempDir, 'worktree')
        execSync('git init', { cwd: tempDir })
        execSync('git config user.email test@example.com', { cwd: tempDir })
        execSync('git config user.name Test', { cwd: tempDir })
        execSync('git commit --allow-empty -m init', { cwd: tempDir })
        execSync(`git worktree add "${worktreeDir}" -b feature-test`, { cwd: tempDir })

        const mockDocker = createMockDockerService()
        const logger = createMockLogger()
        const manager = createSandboxManager(
          mockDocker as unknown as DockerService,
          { image: 'oc-forge-sandbox:latest' },
          logger
        )

        await manager.start('test', worktreeDir)

        const createCalls = mockDocker.getCreateContainerCalls()
        expect(createCalls.length).toBe(1)
        const mounts = createCalls[0][3] ?? []
        const gitDir = execSync('git rev-parse --git-dir', { cwd: worktreeDir, encoding: 'utf-8' }).trim()
        const commonDir = execSync('git rev-parse --git-common-dir', { cwd: worktreeDir, encoding: 'utf-8' }).trim()
        const absoluteGitDir = resolve(worktreeDir, gitDir)
        const absoluteCommonDir = resolve(worktreeDir, commonDir)

        expect(mounts).toContain(`${absoluteGitDir}:${absoluteGitDir}`)
        expect(mounts).toContain(`${absoluteCommonDir}:${absoluteCommonDir}`)
        expect(mounts.some(mount => mount.endsWith(':ro'))).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('stop', () => {
    test('removes container and clears active map', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')
      await manager.stop('test')

      expect(mockDocker.getRemoveContainerCalls()).toContain('oc-forge-sandbox-test')
      expect(manager.isActive('test')).toBe(false)
    })

    test('clears active map even when removeContainer throws', async () => {
      const mockDocker = createMockDockerService()
      mockDocker.setRemoveThrow(true)
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')
      await manager.stop('test')

      expect(manager.isActive('test')).toBe(false)
    })

    test('uses containerName fallback when not in active map', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.stop('unknown')

      expect(mockDocker.getRemoveContainerCalls()).toContain('oc-forge-sandbox-unknown')
    })
  })

  describe('getActive and isActive', () => {
    test('returns null and false for unknown worktree', () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      expect(manager.getActive('unknown')).toBeNull()
      expect(manager.isActive('unknown')).toBe(false)
    })

    test('returns active sandbox after start', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')

      const active = manager.getActive('test')
      expect(active).not.toBeNull()
      expect(manager.isActive('test')).toBe(true)
    })

    test('returns null and false after stop', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')
      await manager.stop('test')

      expect(manager.getActive('test')).toBeNull()
      expect(manager.isActive('test')).toBe(false)
    })
  })

  describe('cleanupOrphans additional', () => {
    test('handles empty container list', async () => {
      const mockDocker = createMockDockerService()
      mockDocker.setContainers([])
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      const removed = await manager.cleanupOrphans()

      expect(removed).toBe(0)
    })

    test('continues cleanup when removal fails', async () => {
      const mockDocker = createMockDockerService()
      mockDocker.setContainers(['oc-forge-sandbox-first', 'oc-forge-sandbox-second'])
      mockDocker.setRemoveThrow(true)
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.cleanupOrphans()

      const calls = mockDocker.getRemoveContainerCalls()
      expect(calls).toContain('oc-forge-sandbox-first')
      expect(calls).toContain('oc-forge-sandbox-second')
    })
  })

  describe('isLive', () => {
    test('returns false when worktree is not in active map', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      const result = await manager.isLive('unknown')

      expect(result).toBe(false)
    })

    test('returns true when worktree is in map and Docker reports container running', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')

      const result = await manager.isLive('test')

      expect(result).toBe(true)
      expect(manager.isActive('test')).toBe(true)
    })

    test('returns false and removes stale map entry when Docker reports container not running', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      // Start a container to add it to the active map
      await manager.start('test', '/path')
      expect(manager.isActive('test')).toBe(true)

      // Simulate Docker reporting the container is not running
      mockDocker.setRunning('oc-forge-sandbox-test', false)

      const result = await manager.isLive('test')

      expect(result).toBe(false)
      // Stale map entry should have been removed
      expect(manager.isActive('test')).toBe(false)
    })
  })
})
