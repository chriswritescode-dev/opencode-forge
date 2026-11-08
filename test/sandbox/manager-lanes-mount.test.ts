import { describe, test, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { createSandboxManager } from '../../src/sandbox/manager'
import { forgeLanesDir } from '../../src/workspace/forge-naming'
import { createMockSandboxRuntime } from '../helpers/sandbox-mocks'
import { createMockLogger } from '../helpers/logger'

describe('SandboxManager lanes mount', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  function createTempRoot(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-lanes-mount-')))
    tmpDirs.push(dir)
    return dir
  }

  test('mounts the loop lanes root read-write at the identical container path', async () => {
    const worktree = join(createTempRoot(), 'feature')
    mkdirSync(worktree)
    const lanesDir = forgeLanesDir(worktree)
    mkdirSync(lanesDir)

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const manager = createSandboxManager(runtime, { image: 'oc-forge-sandbox:latest' }, logger)

    await manager.start('test', worktree)

    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toContainEqual({ hostDir: realpathSync(lanesDir), containerDir: lanesDir })
    const lanesWorkspace = workspaces.find((m) => m.containerDir === lanesDir)
    expect(lanesWorkspace?.readOnly).not.toBe(true)

    const active = manager.getActive('test')
    expect(active?.mounts).toContainEqual({ hostDir: lanesDir, containerDir: lanesDir })
  })

  test('skips the lanes mount when the worktree has no lanes root', async () => {
    const worktree = join(createTempRoot(), 'feature')

    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const manager = createSandboxManager(runtime, { image: 'oc-forge-sandbox:latest' }, logger)

    await manager.start('test', worktree)

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(1)
    expect(active?.mounts[0]).toEqual({ hostDir: resolve(worktree), containerDir: resolve(worktree) })
  })
})
