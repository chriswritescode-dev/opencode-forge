import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockSandboxRuntime } from '../helpers/sandbox-mocks'
import { createMockLogger } from '../helpers/logger'

describe('SandboxManager skills mount', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  function createTempDir(prefix = 'forge-skills-mount-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tmpDirs.push(dir)
    return dir
  }

  test('mounts the skills dir read-only at the identical container path', async () => {
    const skillsDir = createTempDir()
    mkdirSync(join(skillsDir, 'pr-review'), { recursive: true })

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      skillsDir,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const resolved = resolve(skillsDir)

    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toContainEqual({ hostDir: realpathSync(resolved), containerDir: resolved, readOnly: true })

    const active = manager.getActive('test')
    expect(active?.mounts).toContainEqual({ hostDir: resolved, containerDir: resolved, readOnly: true })
  })

  test('mounts the canonical target of a symlinked skill outside the skills dir read-only', async () => {
    const root = createTempDir()
    const skillsDir = join(root, 'skills')
    const external = join(root, 'external-skills', 'media-use')
    mkdirSync(join(skillsDir, 'pr-review'), { recursive: true })
    mkdirSync(external, { recursive: true })
    symlinkSync(external, join(skillsDir, 'media-use'), 'dir')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      skillsDir,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const resolved = resolve(skillsDir)
    const resolvedExternal = realpathSync(external)

    const active = manager.getActive('test')
    expect(active?.mounts).toContainEqual({ hostDir: resolved, containerDir: resolved, readOnly: true })
    expect(active?.mounts).toContainEqual({ hostDir: resolvedExternal, containerDir: resolvedExternal, readOnly: true })

    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toContainEqual({ hostDir: realpathSync(resolved), containerDir: resolved, readOnly: true })
    expect(workspaces).toContainEqual({ hostDir: resolvedExternal, containerDir: resolvedExternal, readOnly: true })
  })

  test('adds nothing when the skills dir does not exist', async () => {
    const missing = join(tmpdir(), 'forge-skills-mount-missing-does-not-exist')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      skillsDir: missing,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(1)
    expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
  })

  test('does not duplicate a custom mount of the skills dir', async () => {
    const skillsDir = createTempDir()

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      skillsDir,
      customMounts: [{ host: skillsDir, readonly: true }],
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const resolved = resolve(skillsDir)
    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(2)
    expect(active?.mounts.filter((m) => m.hostDir === resolved)).toEqual([
      { hostDir: resolved, containerDir: resolved, readOnly: true },
    ])

    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces.filter((m) => m.containerDir === resolved)).toEqual([
      { hostDir: realpathSync(resolved), containerDir: resolved, readOnly: true },
    ])
  })
})
