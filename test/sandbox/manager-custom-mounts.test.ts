import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
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

describe('SandboxManager custom mounts', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-custom-mount-'))
    tmpDirs.push(dir)
    return dir
  }

  test('RW and RO custom mounts appear in extraMounts', async () => {
    const tmpRW = createTempDir()
    const tmpRO = createTempDir()

    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      customMounts: [
        { host: tmpRW, container: '/cache' },
        { host: tmpRO, container: '/ref', readonly: true },
      ],
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const calls = mockDocker.getCreateContainerCalls()
    expect(calls.length).toBe(1)
    const opts = calls[0][3] as { extraMounts?: string[] } | undefined
    const mounts = opts?.extraMounts ?? []

    // RW mount: host:container without :ro
    expect(mounts).toContain(`${resolve(tmpRW)}:/cache`)
    expect(mounts).not.toContain(`${resolve(tmpRW)}:/cache:ro`)

    // RO mount: host:container with :ro
    expect(mounts).toContain(`${resolve(tmpRO)}:/ref:ro`)
  })

  test('custom mounts appear in active.mounts', async () => {
    const tmpRW = createTempDir()
    const tmpRO = createTempDir()

    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      customMounts: [
        { host: tmpRW, container: '/cache' },
        { host: tmpRO, container: '/ref', readonly: true },
      ],
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(3)
    expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/workspace' })
    expect(active?.mounts[1]).toEqual({ hostDir: resolve(tmpRW), containerDir: '/cache', readOnly: false })
    expect(active?.mounts[2]).toEqual({ hostDir: resolve(tmpRO), containerDir: '/ref', readOnly: true })
  })

  test('collision with project mount container path is skipped', async () => {
    const tmpRW = createTempDir()

    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/main-project',
      projectMountPath: '/project',
      customMounts: [
        { host: tmpRW, container: '/project' },
      ],
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const calls = mockDocker.getCreateContainerCalls()
    const opts = calls[0][3] as { extraMounts?: string[] } | undefined
    const mounts = opts?.extraMounts ?? []

    // Project mount should still be present as read-only
    expect(mounts).toContain('/main-project:/project:ro')
    // Custom mount at /project should be skipped (collision)
    expect(mounts).not.toContain(`${resolve(tmpRW)}:/project`)
    expect(mounts).not.toContain(`${resolve(tmpRW)}:/project:ro`)

    // Active mounts should include only the project mount, not the custom one
    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(2)
    expect(active?.mounts[1]).toEqual({ hostDir: '/main-project', containerDir: '/project', readOnly: true })
  })

  test('coexists with project mount', async () => {
    const tmpCustom = createTempDir()

    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/main-project',
      projectMountPath: '/project',
      customMounts: [
        { host: tmpCustom, container: '/tools' },
      ],
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const calls = mockDocker.getCreateContainerCalls()
    const opts = calls[0][3] as { extraMounts?: string[] } | undefined
    const mounts = opts?.extraMounts ?? []

    // Project mount
    expect(mounts).toContain('/main-project:/project:ro')
    // Custom mount
    expect(mounts).toContain(`${resolve(tmpCustom)}:/tools`)

    // Active mounts should have 3 entries: workspace, project, custom
    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(3)
    expect(active?.mounts[1]).toEqual({ hostDir: '/main-project', containerDir: '/project', readOnly: true })
    expect(active?.mounts[2]).toEqual({ hostDir: resolve(tmpCustom), containerDir: '/tools', readOnly: false })
  })
})
