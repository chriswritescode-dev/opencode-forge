import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, spawnSync } from 'child_process'
import { getGitProjectId } from '../src/utils/project-id'

const TEST_PREFIX = join(tmpdir(), 'forge-pid-')

function createTempDir(prefix: string = TEST_PREFIX): string {
  return mkdtempSync(prefix)
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

function runGit(args: string[], cwd: string) {
  return execSync(`git ${args.join(' ')}`, { encoding: 'utf-8', cwd }).trim()
}

function spawnGit(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' })
}

describe('getGitProjectId', () => {
  let tempDir: string

  afterEach(() => {
    if (tempDir) {
      cleanup(tempDir)
    }
  })

  test('returns cached id from .git/opencode when present', () => {
    tempDir = createTempDir()
    runGit(['init'], tempDir)
    runGit(['config', 'user.email', 'test@example.com'], tempDir)
    runGit(['config', 'user.name', 'Test User'], tempDir)
    spawnGit(['commit', '--allow-empty', '-m', 'initial'], tempDir)

    const cacheFile = join(tempDir, '.git', 'opencode')
    writeFileSync(cacheFile, 'cached-id-123')

    const result = getGitProjectId(tempDir)
    expect(result).toBe('cached-id-123')
  })

  test('falls back to oldest root commit when cache file missing', () => {
    tempDir = createTempDir()
    runGit(['init'], tempDir)
    runGit(['config', 'user.email', 'test@example.com'], tempDir)
    runGit(['config', 'user.name', 'Test User'], tempDir)
    spawnGit(['commit', '--allow-empty', '-m', 'initial'], tempDir)

    const expected = runGit(['rev-list', '--max-parents=0', '--all'], tempDir).split('\n').sort()[0]

    const result = getGitProjectId(tempDir)
    expect(result).toBe(expected)
  })

  test('works inside a linked worktree (reads main repo cached id)', () => {
    const mainDir = createTempDir(TEST_PREFIX + 'main-')
    tempDir = mainDir

    runGit(['init'], mainDir)
    runGit(['config', 'user.email', 'test@example.com'], mainDir)
    runGit(['config', 'user.name', 'Test User'], mainDir)
    spawnGit(['commit', '--allow-empty', '-m', 'initial'], mainDir)

    const cacheFile = join(mainDir, '.git', 'opencode')
    writeFileSync(cacheFile, 'shared-id-456')

    const worktreeDir = createTempDir(TEST_PREFIX + 'wt-')
    spawnGit(['worktree', 'add', worktreeDir, '-b', 'wt'], mainDir)

    try {
      const result = getGitProjectId(worktreeDir)
      expect(result).toBe('shared-id-456')
    } finally {
      cleanup(worktreeDir)
    }
  })

  test('falls back to oldest commit inside a worktree when cache file missing', () => {
    const mainDir = createTempDir(TEST_PREFIX + 'main-')
    tempDir = mainDir

    runGit(['init'], mainDir)
    runGit(['config', 'user.email', 'test@example.com'], mainDir)
    runGit(['config', 'user.name', 'Test User'], mainDir)
    spawnGit(['commit', '--allow-empty', '-m', 'initial'], mainDir)

    const worktreeDir = createTempDir(TEST_PREFIX + 'wt-')
    spawnGit(['worktree', 'add', worktreeDir, '-b', 'wt'], mainDir)

    try {
      const expected = runGit(['rev-list', '--max-parents=0', '--all'], mainDir).split('\n').sort()[0]

      const result = getGitProjectId(worktreeDir)
      expect(result).toBe(expected)
    } finally {
      cleanup(worktreeDir)
    }
  })

  test('returns null outside a git repo', () => {
    tempDir = createTempDir()
    const result = getGitProjectId(tempDir)
    expect(result).toBeNull()
  })

  test('returns null for non-existent directory', () => {
    const nonExistentDir = join(tmpdir(), 'does-not-exist-' + Date.now())
    const result = getGitProjectId(nonExistentDir)
    expect(result).toBeNull()
  })
})
