import { describe, test, expect, vi } from 'vitest'
import { gitBranchExists, loopBranchExists } from '../../src/workspace/forge-naming'
import { createFakeGitService } from '../helpers/fake-git'
import type { GitService } from '../../src/utils/git-service'

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
