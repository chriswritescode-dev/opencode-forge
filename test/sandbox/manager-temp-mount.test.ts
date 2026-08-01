import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockLogger, createMockSandboxRuntime } from '../helpers/sandbox-mocks'

describe('SandboxManager temp mount', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  function createTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-temp-mount-'))
    tmpDirs.push(dir)
    return dir
  }

  test('mounts the temp dir read-write at the identical container path', async () => {
    const tmpDir = join(createTempRoot(), 'oc-forge')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      tmpDir,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const resolved = resolve(tmpDir)

    // Created on demand (writable scratch space), unlike the read-only tool-output mount.
    expect(existsSync(resolved)).toBe(true)

    // Appears in workspaces as read-write
    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toContainEqual({ hostDir: resolved, readOnly: false })

    const active = manager.getActive('test')
    expect(active?.mounts).toContainEqual({ hostDir: resolved, containerDir: resolved, readOnly: false })
  })

  test('skips the mount when no temp dir is configured', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = { image: 'oc-forge-sandbox:latest' }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(1)
  })

  test('skips the mount when it is nested inside the workspace', async () => {
    const workspace = createTempRoot()
    const nested = join(workspace, '.forge', 'tmp')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      tmpDir: nested,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', workspace)

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(1)
    expect(active?.mounts[0]).toEqual({ hostDir: resolve(workspace), containerDir: resolve(workspace) })
  })

  test('drops the temp mount when it is nested inside the tool-output mount', async () => {
    // tool-output mount requires its host dir to already exist; point it at the temp root.
    const root = createTempRoot()
    const tmpDir = join(root, 'oc-forge')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      toolOutputDir: root,
      tmpDir,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    const tmpResolved = resolve(tmpDir)
    // The tmp dir overlaps the read-only tool-output mount (its ancestor) and arrives after it
    // in priority order, so it is dropped — `sbx` rejects overlapping workspace paths.
    expect(active?.mounts).toContainEqual({ hostDir: resolve(root), containerDir: resolve(root), readOnly: true })
    expect(active?.mounts.some((m) => m.hostDir === tmpResolved)).toBe(false)
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/dropping workspace/))
  })
})
