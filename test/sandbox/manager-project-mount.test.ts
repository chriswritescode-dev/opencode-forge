import { describe, test, expect } from 'vitest'
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

function createMockDockerService() {
  const createContainerCalls: Array<[string, string, string, Record<string, unknown> | undefined]> = []
  let runningContainers = new Set<string>()

  const mock = {
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
    isRunning: async (name: string) => runningContainers.has(name),
    containerName: (worktreeName: string) => `forge-${worktreeName}`,
    listContainersByPrefix: async () => [],
    getCreateContainerCalls: () => createContainerCalls,
    setRunning: (name: string, running: boolean) => {
      if (running) runningContainers.add(name); else runningContainers.delete(name)
    },
  }
  return mock
}

describe('SandboxManager project mount', () => {
  test('adds project mount to extraMounts when sourceProjectDir differs from worktreeDir', async () => {
    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/home/user/main-project',
      mountProjectReadonly: true,
      projectMountPath: '/project',
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const calls = mockDocker.getCreateContainerCalls()
    expect(calls.length).toBe(1)
    const opts = calls[0][3] as { extraMounts?: string[] } | undefined
    expect(opts?.extraMounts).toContain('/home/user/main-project:/project:ro')
  })

  test('does not add project mount when mountProjectReadonly is false', async () => {
    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/home/user/main-project',
      mountProjectReadonly: false,
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const calls = mockDocker.getCreateContainerCalls()
    const opts = calls[0][3] as { extraMounts?: string[] } | undefined
    const mounts = opts?.extraMounts ?? []
    expect(mounts.every(m => !m.includes('/project'))).toBe(true)
  })

  test('does not add project mount when sourceProjectDir equals worktreeDir', async () => {
    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/home/user/project',
      mountProjectReadonly: true,
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/project')

    const calls = mockDocker.getCreateContainerCalls()
    const opts = calls[0][3] as { extraMounts?: string[] } | undefined
    const mounts = opts?.extraMounts ?? []
    expect(mounts.every(m => !m.includes(':/project'))).toBe(true)
  })

  test('does not add project mount when sourceProjectDir is not configured', async () => {
    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/project')

    const calls = mockDocker.getCreateContainerCalls()
    const opts = calls[0][3] as { extraMounts?: string[] } | undefined
    const mounts = opts?.extraMounts ?? []
    expect(mounts.every(m => !m.includes(':/project'))).toBe(true)
  })

  test('mounts list on active sandbox includes both worktree and project mounts', async () => {
    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/main-project',
      mountProjectReadonly: true,
      projectMountPath: '/project',
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(3)
    expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/workspace' })
    expect(active?.mounts[1]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
    expect(active?.mounts[2]).toEqual({ hostDir: '/main-project', containerDir: '/project', readOnly: true })
  })

  test('mounts list only has worktree mount when project mount is disabled', async () => {
    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/main-project',
      mountProjectReadonly: false,
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(2)
    expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/workspace' })
    expect(active?.mounts[1]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
  })

  describe('reconnect paths', () => {
    test('start() with already-running container preserves project mount in mounts list', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        sourceProjectDir: '/main-project',
        mountProjectReadonly: true,
        projectMountPath: '/project',
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)

      // Start container first (creates it)
      await manager.start('test', '/home/user/worktrees/feature')
      expect(mockDocker.getCreateContainerCalls().length).toBe(1)

      // Simulate reconnect: container already running
      const result = await manager.start('test', '/home/user/worktrees/feature')

      // Should not have created a new container
      expect(mockDocker.getCreateContainerCalls().length).toBe(1)
      // Mounts should include both worktree and project
      const active = manager.getActive('test')
      expect(active?.mounts).toHaveLength(3)
      expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/workspace' })
      expect(active?.mounts[1]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
      expect(active?.mounts[2]).toEqual({ hostDir: '/main-project', containerDir: '/project', readOnly: true })
    })

    test('start() with already-running container does not add project mount when disabled', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        sourceProjectDir: '/main-project',
        mountProjectReadonly: false,
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)

      await manager.start('test', '/home/user/worktrees/feature')
      await manager.start('test', '/home/user/worktrees/feature')

      const active = manager.getActive('test')
      expect(active?.mounts).toHaveLength(2)
      expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/workspace' })
      expect(active?.mounts[1]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
    })

    test('restore() with already-running container preserves project mount in mounts list', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        sourceProjectDir: '/main-project',
        mountProjectReadonly: true,
        projectMountPath: '/project',
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)

      // Simulate container already running (e.g. after plugin restart)
      mockDocker.setRunning('forge-foo', true)
      await manager.restore('foo', '/home/user/worktrees/feature', '2025-01-01T00:00:00.000Z')

      // Should not have created a new container
      expect(mockDocker.getCreateContainerCalls().length).toBe(0)
      // Mounts should include both worktree and project
      const active = manager.getActive('foo')
      expect(active?.mounts).toHaveLength(3)
      expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/workspace' })
      expect(active?.mounts[1]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
      expect(active?.mounts[2]).toEqual({ hostDir: '/main-project', containerDir: '/project', readOnly: true })
    })

    test('restore() with already-running container does not add project mount when disabled', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        sourceProjectDir: '/main-project',
        mountProjectReadonly: false,
      }

      const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)

      mockDocker.setRunning('forge-foo', true)
      await manager.restore('foo', '/home/user/worktrees/feature', '2025-01-01T00:00:00.000Z')

      const active = manager.getActive('foo')
      expect(active?.mounts).toHaveLength(2)
      expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/workspace' })
      expect(active?.mounts[1]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
    })
  })
})
