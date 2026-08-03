import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockLogger, createMockSandboxRuntime } from '../helpers/sandbox-mocks'

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

  test('RW and RO custom mounts appear in workspaces', async () => {
    const tmpRW = createTempDir()
    const tmpRO = createTempDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      customMounts: [
        { host: tmpRW, readonly: false },
        { host: tmpRO, readonly: true },
      ],
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const calls = runtime.getCreateSandboxCalls()
    expect(calls.length).toBe(1)
    const workspaces = calls[0][1]

    // RW mount: readOnly false
    expect(workspaces).toContainEqual({ hostDir: resolve(tmpRW), readOnly: false })
    // RO mount: readOnly true
    expect(workspaces).toContainEqual({ hostDir: resolve(tmpRO), readOnly: true })
  })

  test('custom mounts appear in active.mounts', async () => {
    const tmpRW = createTempDir()
    const tmpRO = createTempDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      customMounts: [
        { host: tmpRW, readonly: false },
        { host: tmpRO, readonly: true },
      ],
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(3)
    expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
    expect(active?.mounts[1]).toEqual({ hostDir: resolve(tmpRW), containerDir: resolve(tmpRW), readOnly: false })
    expect(active?.mounts[2]).toEqual({ hostDir: resolve(tmpRO), containerDir: resolve(tmpRO), readOnly: true })
  })

  test('custom mount nested inside the worktree is skipped', async () => {
    const workspace = createTempDir()
    const nested = join(workspace, 'cache')
    mkdirSync(nested, { recursive: true })

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      customMounts: [{ host: nested, readonly: false }],
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', workspace)

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(1)
    expect(active?.mounts[0]).toEqual({ hostDir: resolve(workspace), containerDir: resolve(workspace) })

    // Custom mount should not be in the workspaces passed to createSandbox
    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toEqual([{ hostDir: resolve(workspace) }])
  })

  test('custom mount whose host equals the project source dir is skipped', async () => {
    const projectDir = createTempDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: projectDir,
      customMounts: [{ host: projectDir, readonly: false }],
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(2)
    // Project mount is present
    expect(active?.mounts[1]).toEqual({ hostDir: resolve(projectDir), containerDir: resolve(projectDir), readOnly: true })
    // Custom mount at the identical host is skipped (collision with project mount)
    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toEqual([
      { hostDir: '/home/user/worktrees/feature' },
      { hostDir: resolve(projectDir), readOnly: true },
    ])
  })

  test('custom mount whose host equals an earlier accepted host is skipped', async () => {
    const shared = createTempDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      customMounts: [
        { host: shared, readonly: false },
        { host: shared, readonly: true },
      ],
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(2)
    expect(active?.mounts[1]).toEqual({ hostDir: resolve(shared), containerDir: resolve(shared), readOnly: false })

    // Only the first custom mount appears in workspaces
    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toEqual([
      { hostDir: '/home/user/worktrees/feature' },
      { hostDir: resolve(shared), readOnly: false },
    ])
  })

  test('custom mount coexists with the project mount', async () => {
    const tmpCustom = createTempDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/tmp',
      customMounts: [{ host: tmpCustom, readonly: false }],
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(3)
    expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
    expect(active?.mounts[1]).toEqual({ hostDir: '/tmp', containerDir: '/tmp', readOnly: true })
    expect(active?.mounts[2]).toEqual({ hostDir: resolve(tmpCustom), containerDir: resolve(tmpCustom), readOnly: false })

    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toContainEqual({ hostDir: '/tmp', readOnly: true })
    expect(workspaces).toContainEqual({ hostDir: resolve(tmpCustom), readOnly: false })
  })
})
