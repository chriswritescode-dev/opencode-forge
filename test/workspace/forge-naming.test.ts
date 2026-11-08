import { describe, test, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import {
  forgeLaneBranchName,
  forgeLaneDir,
  forgeLanesDir,
  gitBranchExists,
  listForgeWorktreeDirs,
  loopBranchExists,
  isForgeWorktreeDir,
  isWithinDir,
  parseForgeLaneDir,
  resolveLoopBranchName,
} from '../../src/workspace/forge-naming'
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

describe('resolveLoopBranchName', () => {
  test('returns the explicit branch when it is non-empty', () => {
    expect(resolveLoopBranchName('my-loop', 'custom/b')).toBe('custom/b')
  })

  test('falls back to forgeBranchName when the explicit branch is absent or empty', () => {
    expect(resolveLoopBranchName('my-loop')).toBe('forge/my-loop')
    expect(resolveLoopBranchName('my-loop', null)).toBe('forge/my-loop')
    expect(resolveLoopBranchName('my-loop', '')).toBe('forge/my-loop')
  })

  test('slugifies the loop name in the fallback', () => {
    expect(resolveLoopBranchName('My Loop!')).toBe('forge/my-loop')
    expect(resolveLoopBranchName('foo_bar')).toBe('forge/foo_bar')
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

describe('forgeLanesDir', () => {
  test('appends the lanes suffix to the loop worktree dir', () => {
    expect(forgeLanesDir('/root/loops/my-loop')).toBe('/root/loops/my-loop.lanes')
  })
})

describe('forgeLaneDir', () => {
  test('nests the section dir under the lanes root', () => {
    expect(forgeLaneDir('/root/loops/my-loop', 'section-1')).toBe('/root/loops/my-loop.lanes/section-1')
  })
})

describe('forgeLaneBranchName', () => {
  test('scopes the lane branch to the loop worktree slug and section', () => {
    expect(forgeLaneBranchName('my-loop', 'section-1')).toBe('forge-lane/my-loop/section-1')
  })

  test('slugifies the loop name', () => {
    expect(forgeLaneBranchName('My Loop!', 'section-1')).toBe('forge-lane/my-loop/section-1')
  })
})

describe('parseForgeLaneDir', () => {
  test('splits a lane dir into its loop worktree and section id', () => {
    expect(parseForgeLaneDir('/root/loops/my-loop.lanes/section-2')).toEqual({
      loopWorktreeDir: '/root/loops/my-loop',
      sectionId: 'section-2',
    })
  })

  test('rejects a normal worktree path', () => {
    expect(parseForgeLaneDir('/root/loops/my-loop')).toBeNull()
  })

  test('rejects a directory whose parent is not a lanes root', () => {
    expect(parseForgeLaneDir('/root/loops/my-loop/section-2')).toBeNull()
  })

  test('rejects a lanes parent whose slug is not slug-shaped', () => {
    expect(parseForgeLaneDir('/root/loops/bad.slug.lanes/section-2')).toBeNull()
  })

  test('rejects a lanes parent with an empty slug', () => {
    expect(parseForgeLaneDir('/root/loops/.lanes/section-2')).toBeNull()
  })

  test('rejects an empty section id', () => {
    expect(parseForgeLaneDir('/root/loops/my-loop.lanes/')).toBeNull()
  })

  test('rejects an uppercase section id', () => {
    expect(parseForgeLaneDir('/root/loops/my-loop.lanes/Section-2')).toBeNull()
  })

  test('rejects a section id containing a path separator', () => {
    expect(parseForgeLaneDir('/root/loops/my-loop.lanes/section-2/nested')).toBeNull()
  })

  test('rejects empty input', () => {
    expect(parseForgeLaneDir('')).toBeNull()
  })
})

describe('listForgeWorktreeDirs', () => {
  test('lists loop worktrees and skips lane roots', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'forge-naming-'))
    try {
      const root = join(dataDir, 'worktrees')
      mkdirSync(join(root, 'loop-a'), { recursive: true })
      mkdirSync(join(root, 'loop-a.lanes'), { recursive: true })
      mkdirSync(join(root, 'loop-b'), { recursive: true })
      const names = listForgeWorktreeDirs(dataDir).map((dir) => basename(dir))
      expect(names.sort()).toEqual(['loop-a', 'loop-b'])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('returns an empty list when the worktrees root does not exist', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'forge-naming-'))
    try {
      expect(listForgeWorktreeDirs(join(dataDir, 'missing'))).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
