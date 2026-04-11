import { describe, test, expect } from 'bun:test'
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
  const createContainerCalls: Array<[string, string, string]> = []
  let containers = ['oc-forge-sandbox-foo', 'oc-forge-sandbox-bar']
  let runningContainers = new Set<string>()
  let shouldDockerBeAvailable = true
  let shouldImageExist = true
  let shouldRemoveThrow = false

  const mock = {
    checkDocker: async () => shouldDockerBeAvailable,
    imageExists: async () => shouldImageExist,
    buildImage: async () => {},
    createContainer: async (name: string, projectDir: string, image: string) => {
      createContainerCalls.push([name, projectDir, image])
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
})
