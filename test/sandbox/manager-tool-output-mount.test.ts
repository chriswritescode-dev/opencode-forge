import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import type { DockerService } from '../../src/sandbox/docker'
import { createMockLogger, createMockDockerService } from '../helpers/sandbox-mocks'

describe('SandboxManager tool-output mount', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-tool-output-'))
    tmpDirs.push(dir)
    return dir
  }

  test('mounts the tool-output dir read-only at the identical container path', async () => {
    const toolOutputDir = createTempDir()

    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      toolOutputDir,
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const resolved = resolve(toolOutputDir)

    const calls = mockDocker.getCreateContainerCalls()
    const opts = calls[0][3] as { extraMounts?: string[] } | undefined
    const mounts = opts?.extraMounts ?? []
    expect(mounts).toContain(`${resolved}:${resolved}:ro`)

    const active = manager.getActive('test')
    expect(active?.mounts).toContainEqual({ hostDir: resolved, containerDir: resolved, readOnly: true })
  })

  test('skips the mount when the tool-output dir does not exist', async () => {
    const missing = join(tmpdir(), 'forge-tool-output-missing-does-not-exist')

    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      toolOutputDir: missing,
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(1)
    expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/workspace' })
  })

  test('skips the mount when no tool-output dir is configured', async () => {
    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(1)
  })

  test('skips the mount when it is nested inside the workspace', async () => {
    const workspace = createTempDir()
    const nested = join(workspace, '.forge', 'tool-output')

    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      toolOutputDir: nested,
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', workspace)

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(1)
    expect(active?.mounts[0]).toEqual({ hostDir: resolve(workspace), containerDir: '/workspace' })
  })

  test('coexists with the project mount', async () => {
    const toolOutputDir = createTempDir()

    const mockDocker = createMockDockerService()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/main-project',
      projectMountPath: '/project',
      toolOutputDir,
    }

    const manager = createSandboxManager(mockDocker as unknown as DockerService, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const resolved = resolve(toolOutputDir)
    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(3)
    expect(active?.mounts[1]).toEqual({ hostDir: '/main-project', containerDir: '/project', readOnly: true })
    expect(active?.mounts[2]).toEqual({ hostDir: resolved, containerDir: resolved, readOnly: true })
  })
})
