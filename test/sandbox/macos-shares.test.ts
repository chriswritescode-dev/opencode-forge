import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  assertDirectoryInsideMacosShares,
  macosMountsFromShares,
  macosShareTag,
  planMacosShares,
} from '../../src/sandbox/macos-shares'
import { createMockLogger } from '../helpers/logger'

describe('macOS shares', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-macos-shares-'))
    tmpDirs.push(dir)
    return dir
  }

  function plan(roots: string[], extra: Partial<Parameters<typeof planMacosShares>[0]> = {}) {
    return planMacosShares(
      {
        roots,
        worktreesDir: join(createTempDir(), 'worktrees'),
        extraMounts: [],
        homeDir: createTempDir(),
        ...extra,
      },
      createMockLogger(),
    )
  }

  test('share tags are deterministic, distinct, and well formed', () => {
    const first = createTempDir()
    const second = createTempDir()

    expect(macosShareTag(first)).toBe(macosShareTag(first))
    expect(macosShareTag(first)).not.toBe(macosShareTag(second))
    expect(macosShareTag(first)).toMatch(/^forge-[0-9a-f]{12}$/)
    expect(macosShareTag(first).length).toBeLessThanOrEqual(36)
  })

  test('expands a leading ~/ root against homeDir', () => {
    const homeDir = createTempDir()
    const projectDir = join(homeDir, 'projects', 'demo')
    mkdirSync(projectDir, { recursive: true })

    const shares = plan(['~/projects/demo'], { homeDir, worktreesDir: join(createTempDir(), 'worktrees') })

    const share = shares.find((entry) => entry.guestDir === projectDir)
    expect(share).toBeDefined()
    expect(share?.readOnly).toBe(false)
  })

  test('skips a root that does not exist', () => {
    const valid = createTempDir()
    const missing = join(createTempDir(), 'missing')

    const shares = plan([valid, missing], { worktreesDir: join(createTempDir(), 'worktrees') })

    expect(shares).toHaveLength(2)
    expect(shares.map((entry) => entry.guestDir)).toContain(valid)
    expect(shares.map((entry) => entry.guestDir)).not.toContain(missing)
  })

  test('two roots plus worktreesDir produce three writable shares with distinct tags', () => {
    const first = createTempDir()
    const second = createTempDir()
    const worktreesDir = join(createTempDir(), 'worktrees')

    const shares = plan([first, second], { worktreesDir })

    expect(shares).toHaveLength(3)
    expect(shares.every((entry) => entry.readOnly === false)).toBe(true)
    expect(new Set(shares.map((entry) => entry.tag)).size).toBe(3)
    expect(shares.map((entry) => entry.guestDir)).toContain(worktreesDir)
  })

  test('drops a nested root covered by a parent root', () => {
    const parent = createTempDir()
    const nested = join(parent, 'nested')
    mkdirSync(nested, { recursive: true })

    const shares = plan([parent, nested], { worktreesDir: join(createTempDir(), 'worktrees') })

    expect(shares).toHaveLength(2)
    expect(shares.map((entry) => entry.guestDir)).toContain(parent)
    expect(shares.map((entry) => entry.guestDir)).not.toContain(nested)
  })

  test('toolOutputDir and skillsDir produce read-only shares', () => {
    const toolOutputDir = createTempDir()
    const skillsDir = createTempDir()

    const shares = plan([], { worktreesDir: join(createTempDir(), 'worktrees'), toolOutputDir, skillsDir })

    expect(shares.find((entry) => entry.guestDir === toolOutputDir)?.readOnly).toBe(true)
    expect(shares.find((entry) => entry.guestDir === skillsDir)?.readOnly).toBe(true)
  })

  test('preserves the guest path while canonicalizing the host path through a symlink', (ctx) => {
    const realDir = createTempDir()
    const linkDir = join(createTempDir(), 'link')
    try {
      symlinkSync(realDir, linkDir, 'dir')
    } catch {
      ctx.skip()
      return
    }

    const shares = plan([linkDir], { worktreesDir: join(createTempDir(), 'worktrees') })

    const share = shares.find((entry) => entry.guestDir === linkDir)
    expect(share?.hostDir).toBe(realpathSync(realDir))
  })

  test('resolves a not-yet-created directory below a symlinked root', (ctx) => {
    const realDir = createTempDir()
    const linkDir = join(createTempDir(), 'link')
    try {
      symlinkSync(realDir, linkDir, 'dir')
    } catch {
      ctx.skip()
      return
    }

    const shares = plan([linkDir], { worktreesDir: join(createTempDir(), 'worktrees') })

    expect(assertDirectoryInsideMacosShares(join(linkDir, 'not-yet', 'created'), shares).guestDir).toBe(linkDir)
  })

  test('assertDirectoryInsideMacosShares returns the containing writable share', () => {
    const root = createTempDir()
    const worktreesDir = join(createTempDir(), 'worktrees')
    const shares = plan([root], { worktreesDir })

    expect(assertDirectoryInsideMacosShares(join(root, 'sub', 'dir'), shares).guestDir).toBe(root)
    expect(assertDirectoryInsideMacosShares(join(worktreesDir, 'feature'), shares).guestDir).toBe(worktreesDir)
  })

  test('assertDirectoryInsideMacosShares refuses a directory outside every share', () => {
    const root = createTempDir()
    const outside = createTempDir()
    const shares = plan([root], { worktreesDir: join(createTempDir(), 'worktrees'), skillsDir: createTempDir() })

    const readOnlyDirs = shares.filter((entry) => entry.readOnly).map((entry) => entry.guestDir)
    let error: unknown
    try {
      assertDirectoryInsideMacosShares(join(outside, 'file.txt'), shares)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('is outside the macOS sandbox roots')
    expect(message).toContain('Refusing to run it on the host.')
    expect(message).toContain(root)
    for (const readOnlyDir of readOnlyDirs) expect(message).not.toContain(readOnlyDir)
  })

  test('assertDirectoryInsideMacosShares refuses a directory inside a read-only share', () => {
    const root = createTempDir()
    const toolOutputDir = join(root, 'output')
    mkdirSync(toolOutputDir, { recursive: true })
    const shares = plan([root], { worktreesDir: join(createTempDir(), 'worktrees'), toolOutputDir })

    expect(shares.find((entry) => entry.guestDir === toolOutputDir)?.readOnly).toBe(true)
    expect(() => assertDirectoryInsideMacosShares(join(toolOutputDir, 'result.txt'), shares)).toThrow(
      'Refusing to run it on the host.',
    )
  })

  test('macosMountsFromShares maps guest dirs back to identical mounts', () => {
    const shares = plan([createTempDir()], { worktreesDir: join(createTempDir(), 'worktrees') })

    expect(macosMountsFromShares(shares)).toEqual(
      shares.map((share) => ({ hostDir: share.guestDir, containerDir: share.guestDir, readOnly: share.readOnly })),
    )
  })
})
