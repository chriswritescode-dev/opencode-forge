import { describe, test, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockSandboxRuntime } from '../helpers/sandbox-mocks'
import { createMockLogger } from '../helpers/logger'

const WORKSPACE = '/home/user/worktrees/feature'

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

  function createSkill(dir: string): string {
    mkdirSync(dir, { recursive: true })
    const manifest = join(dir, 'SKILL.md')
    writeFileSync(manifest, '# skill\n')
    return manifest
  }

  function createManager(
    listSkillPaths: NonNullable<SandboxManagerConfig['listSkillPaths']>,
    extra: Partial<SandboxManagerConfig> = {},
  ) {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      listSkillPaths,
      ...extra,
    }
    return { manager: createSandboxManager(runtime, config, logger), runtime, logger }
  }

  function readOnlyMount(dir: string) {
    return { hostDir: dir, containerDir: dir, readOnly: true }
  }

  function workspaceEntries(runtime: ReturnType<typeof createMockSandboxRuntime>) {
    return runtime.getCreateSandboxCalls()[0][1]
  }

  test('mounts the skills root read-only once for every skill under it', async () => {
    const root = createTempDir()
    const skillsRoot = join(root, 'skills')
    const manifests = [
      createSkill(join(skillsRoot, 'pr-review')),
      createSkill(join(skillsRoot, 'tdd')),
    ]

    const { manager, runtime } = createManager(async () => manifests)
    await manager.start('test', WORKSPACE)

    const resolved = resolve(skillsRoot)
    const active = manager.getActive('test')
    expect(active?.mounts).toContainEqual(readOnlyMount(resolved))
    expect(active?.mounts.filter((mount) => mount.containerDir.startsWith(resolve(root)))).toHaveLength(1)
    expect(workspaceEntries(runtime)).toContainEqual({
      hostDir: realpathSync(resolved),
      containerDir: resolved,
      readOnly: true,
    })
  })

  test('mounts an individually configured skill directory, not its parent', async () => {
    const root = createTempDir()
    const skillDir = join(root, 'myskill')
    const manifest = createSkill(skillDir)

    const { manager } = createManager(async () => [manifest])
    await manager.start('test', WORKSPACE)

    const active = manager.getActive('test')
    expect(active?.mounts).toContainEqual(readOnlyMount(resolve(skillDir)))
    expect(active?.mounts.some((mount) => mount.containerDir === resolve(root))).toBe(false)
  })

  test('mounts the root plus a skill directory whose symlink target is outside it', async () => {
    const root = createTempDir()
    const skillsRoot = join(root, 'skills')
    const external = join(root, 'external-skills', 'media-use')
    createSkill(join(skillsRoot, 'pr-review'))
    createSkill(external)
    symlinkSync(external, join(skillsRoot, 'media-use'), 'dir')

    const { manager, runtime } = createManager(async () => [
      join(skillsRoot, 'pr-review', 'SKILL.md'),
      join(skillsRoot, 'media-use', 'SKILL.md'),
    ])
    await manager.start('test', WORKSPACE)

    const resolvedRoot = resolve(skillsRoot)
    const resolvedLink = resolve(skillsRoot, 'media-use')
    const active = manager.getActive('test')
    expect(active?.mounts).toContainEqual(readOnlyMount(resolvedRoot))
    expect(active?.mounts).toContainEqual(readOnlyMount(resolvedLink))
    expect(workspaceEntries(runtime)).toContainEqual({
      hostDir: realpathSync(external),
      containerDir: resolvedLink,
      readOnly: true,
    })
  })

  test('ignores flat skills that have no skill directory', async () => {
    const root = createTempDir()
    const flat = join(root, 'skills', 'one-liner.md')
    mkdirSync(join(root, 'skills'), { recursive: true })
    writeFileSync(flat, '# skill\n')

    const { manager } = createManager(async () => [flat])
    await manager.start('test', WORKSPACE)

    const active = manager.getActive('test')
    expect(active?.mounts).toEqual([{ hostDir: WORKSPACE, containerDir: WORKSPACE }])
  })

  test('ignores skills that live inside the workspace', async () => {
    const workspace = createTempDir('forge-skills-workspace-')
    const manifest = createSkill(join(workspace, '.opencode', 'skills', 'local'))

    const { manager } = createManager(async () => [manifest])
    await manager.start('test', workspace)

    const active = manager.getActive('test')
    expect(active?.mounts).toEqual([{ hostDir: workspace, containerDir: workspace }])
  })

  test('falls back to the fallback skills directory when the list rejects', async () => {
    const fallbackDir = createTempDir()
    createSkill(join(fallbackDir, 'pr-review'))

    const { manager, runtime } = createManager(async () => {
      throw new Error('skill list unavailable')
    }, { fallbackSkillsDir: fallbackDir })

    await manager.start('test', WORKSPACE)

    const resolved = resolve(fallbackDir)
    const active = manager.getActive('test')
    expect(active?.mounts).toContainEqual(readOnlyMount(resolved))
    expect(workspaceEntries(runtime)).toContainEqual({
      hostDir: realpathSync(resolved),
      containerDir: resolved,
      readOnly: true,
    })
  })

  test('reuses the previously listed skills when a later list rejects', async () => {
    const root = createTempDir()
    const listedRoot = join(root, 'skills')
    const fallbackDir = createTempDir()
    createSkill(join(listedRoot, 'pr-review'))
    createSkill(join(fallbackDir, 'fallback-skill'))

    let calls = 0
    const { manager, runtime } = createManager(async () => {
      calls += 1
      if (calls === 1) return [join(listedRoot, 'pr-review', 'SKILL.md')]
      throw new Error('skill list unavailable')
    }, { fallbackSkillsDir: fallbackDir })

    await manager.start('test', WORKSPACE)
    await manager.start('test', WORKSPACE)

    const resolvedListed = resolve(listedRoot)
    const resolvedFallback = resolve(fallbackDir)
    const active = manager.getActive('test')
    expect(calls).toBeGreaterThan(1)
    expect(active?.mounts).toContainEqual(readOnlyMount(resolvedListed))
    expect(active?.mounts.some((mount) => mount.containerDir === resolvedFallback)).toBe(false)
    expect(workspaceEntries(runtime).filter((entry) => entry.containerDir === resolvedListed)).toEqual([
      { hostDir: realpathSync(resolvedListed), containerDir: resolvedListed, readOnly: true },
    ])
  })

  test('liveness re-checks reuse the listed skills instead of listing again', async () => {
    const root = createTempDir()
    const manifest = createSkill(join(root, 'skills', 'pr-review'))
    let calls = 0
    const { manager } = createManager(async () => {
      calls += 1
      return [manifest]
    })

    await manager.start('test', WORKSPACE)
    vi.useFakeTimers({ now: Date.now() + 60_000 })
    try {
      await manager.ensureRunning('test', WORKSPACE)
      await manager.ensureRunning('test', WORKSPACE)
    } finally {
      vi.useRealTimers()
    }

    expect(calls).toBe(1)
  })

  test('does not duplicate a custom mount of the skills root', async () => {
    const root = createTempDir()
    const skillsRoot = join(root, 'skills')
    const manifest = createSkill(join(skillsRoot, 'pr-review'))

    const { manager, runtime } = createManager(async () => [manifest], {
      customMounts: [{ host: skillsRoot, readonly: true }],
    })
    await manager.start('test', WORKSPACE)

    const resolved = resolve(skillsRoot)
    const active = manager.getActive('test')
    expect(active?.mounts.filter((mount) => mount.hostDir === resolved)).toEqual([readOnlyMount(resolved)])
    expect(workspaceEntries(runtime).filter((mount) => mount.containerDir === resolved)).toEqual([
      { hostDir: realpathSync(resolved), containerDir: resolved, readOnly: true },
    ])
  })
})
