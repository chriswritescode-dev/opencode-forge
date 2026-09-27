import { describe, test, expect, vi } from 'vitest'
import { gitBranchExists, loopBranchExists, isForgeWorktreeDir, isWithinDir } from '../../src/workspace/forge-naming'
import { createFakeGitService } from '../helpers/fake-git'
import type { GitService } from '../../src/utils/git-service'

describe('isWithinDir', () => {
  const root = '/server/forge/worktrees'

  test('true for the root itself', () => {
    expect(isWithinDir(root, root)).toBe(true)
  })

  test('true for a directory beneath the root', () => {
    expect(isWithinDir(root, `${root}/my-loop`)).toBe(true)
    expect(isWithinDir(root, `${root}/my-loop/nested`)).toBe(true)
  })

  test('false for a sibling that shares a prefix', () => {
    expect(isWithinDir(root, `${root}-archive/x`)).toBe(false)
  })

  test('true for a child whose name starts with dots', () => {
    expect(isWithinDir(root, `${root}/..cache`)).toBe(true)
    expect(isWithinDir(root, `${root}/..cache/nested`)).toBe(true)
  })

  test('false for an unrelated directory', () => {
    expect(isWithinDir(root, '/missing/project')).toBe(false)
  })

  test('false when root or directory is empty', () => {
    expect(isWithinDir('', `${root}/x`)).toBe(false)
    expect(isWithinDir(root, '')).toBe(false)
  })
})

describe('isForgeWorktreeDir', () => {
  const dataDir = '/Users/x/.local/share/opencode/forge'

  test('true for a directory under the worktrees root', () => {
    expect(isForgeWorktreeDir(dataDir, `${dataDir}/worktrees/my-loop`)).toBe(true)
  })

  test('true for the worktrees root itself', () => {
    expect(isForgeWorktreeDir(dataDir, `${dataDir}/worktrees`)).toBe(true)
  })

  test('false for the project root (not under worktrees)', () => {
    expect(isForgeWorktreeDir(dataDir, '/Users/x/development/my-project')).toBe(false)
  })

  test('false for a sibling dir that shares a prefix but is not under worktrees', () => {
    expect(isForgeWorktreeDir(dataDir, `${dataDir}/worktrees-archive/x`)).toBe(false)
  })

  test('false when dataDir or directory is empty', () => {
    expect(isForgeWorktreeDir('', `${dataDir}/worktrees/x`)).toBe(false)
    expect(isForgeWorktreeDir(dataDir, '')).toBe(false)
  })
})

describe('gitBranchExists', () => {
  test('returns true when the fake reports the branch exists', () => {
    const fake = createFakeGitService({
      branchExists: vi.fn<[string, string], boolean>().mockReturnValue(true),
    })
    expect(gitBranchExists('/repo', 'forge/x', fake)).toBe(true)
    expect(fake.branchExists).toHaveBeenCalledWith('/repo', 'forge/x')
  })

  test('returns false when repoDir is empty without calling git', () => {
    const fake = createFakeGitService()
    expect(gitBranchExists('', 'x', fake)).toBe(false)
    expect(fake.branchExists).not.toHaveBeenCalled()
  })

  test('returns false when branch is empty without calling git', () => {
    const fake = createFakeGitService()
    expect(gitBranchExists('/repo', '', fake)).toBe(false)
    expect(fake.branchExists).not.toHaveBeenCalled()
  })
})

describe('loopBranchExists', () => {
  test('derives branch via forgeBranchName and delegates to gitBranchExists', () => {
    const fake = createFakeGitService({
      branchExists: vi.fn<[string, string], boolean>().mockReturnValue(true),
    })
    expect(loopBranchExists({ loopName: 'my-loop' }, '/fallback', fake)).toBe(true)
    expect(fake.branchExists).toHaveBeenCalledWith('/fallback', 'forge/my-loop')
  })

  test('prefers persisted worktreeBranch and projectDir over fallback', () => {
    const fake = createFakeGitService({
      branchExists: vi.fn<[string, string], boolean>().mockReturnValue(true),
    })
    expect(
      loopBranchExists(
        { loopName: 'my-loop', worktreeBranch: 'custom/b', projectDir: '/proj' },
        '/fallback',
        fake,
      ),
    ).toBe(true)
    expect(fake.branchExists).toHaveBeenCalledWith('/proj', 'custom/b')
    expect(fake.branchExists).not.toHaveBeenCalledWith('/fallback', expect.any(String))
  })

  test('returns false when gitBranchExists returns false', () => {
    const fake = createFakeGitService({
      branchExists: vi.fn<[string, string], boolean>().mockReturnValue(false),
    })
    expect(loopBranchExists({ loopName: 'missing' }, '/repo', fake)).toBe(false)
    expect(fake.branchExists).toHaveBeenCalledWith('/repo', 'forge/missing')
  })
})
