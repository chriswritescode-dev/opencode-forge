import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createGitService } from '../../src/utils/git-service'
import { createFakeGitService } from '../helpers/fake-git'
import { describeBranchReuseConflict, validateLoopBranchRequest } from '../../src/workspace/loop-branch'

const git = createGitService()

function run(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf-8' }).trim()
}

function revParse(cwd: string, ref: string): string {
  return run(cwd, `git rev-parse ${ref}`)
}

describe('loop branch validation', () => {
  const createdDirs: string[] = []
  let repoDir: string

  function trackDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    createdDirs.push(dir)
    return dir
  }

  function commit(cwd: string, message: string): void {
    run(cwd, `git commit --allow-empty -m "${message}"`)
  }

  beforeEach(() => {
    repoDir = trackDir('forge-loop-branch-repo-')
    run(repoDir, 'git init -b main -q')
    run(repoDir, 'git config user.email t@t')
    run(repoDir, 'git config user.name t')
    commit(repoDir, 'init')
  })

  afterEach(() => {
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop()!
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('describeBranchReuseConflict', () => {
    it('returns null when the branch does not exist', () => {
      expect(describeBranchReuseConflict(git, repoDir, 'missing-branch', 'main')).toBeNull()
    })

    it('returns null when the branch equals the base ref', () => {
      run(repoDir, 'git branch same-branch')

      expect(describeBranchReuseConflict(git, repoDir, 'same-branch', 'main')).toBeNull()
    })

    it('returns null when the branch is an ancestor of the base ref', () => {
      run(repoDir, 'git branch old-branch')
      commit(repoDir, 'advance main')

      expect(describeBranchReuseConflict(git, repoDir, 'old-branch', 'main')).toBeNull()
    })

    it('describes the conflict when the branch has commits the base ref lacks', () => {
      run(repoDir, 'git branch diverged-branch')
      run(repoDir, 'git checkout -q diverged-branch')
      commit(repoDir, 'diverged work')
      run(repoDir, 'git checkout -q main')
      commit(repoDir, 'main work')

      expect(describeBranchReuseConflict(git, repoDir, 'diverged-branch', 'main')).toBe(
        'Branch diverged-branch has commits that main does not contain; refusing to reuse it for a loop based on main',
      )
    })
  })

  describe('validateLoopBranchRequest', () => {
    it('accepts an empty request', () => {
      expect(validateLoopBranchRequest(git, repoDir, {})).toEqual({ ok: true })
    })

    it('treats empty strings as absent', () => {
      expect(validateLoopBranchRequest(git, repoDir, { branch: '', baseRef: '' })).toEqual({ ok: true })
    })

    it('accepts a new valid branch', () => {
      expect(validateLoopBranchRequest(git, repoDir, { branch: 'feature/new-work' })).toEqual({ ok: true })
    })

    it('accepts an existing branch no worktree has checked out', () => {
      run(repoDir, 'git branch existing-branch')

      expect(validateLoopBranchRequest(git, repoDir, { branch: 'existing-branch' })).toEqual({ ok: true })
    })

    it('accepts an existing branch that equals the base ref', () => {
      run(repoDir, 'git branch same-branch')

      expect(validateLoopBranchRequest(git, repoDir, { branch: 'same-branch', baseRef: 'main' })).toEqual({ ok: true })
    })

    it('accepts an existing branch that is an ancestor of the base ref', () => {
      run(repoDir, 'git branch old-branch')
      commit(repoDir, 'advance main')

      expect(validateLoopBranchRequest(git, repoDir, { branch: 'old-branch', baseRef: 'main' })).toEqual({ ok: true })
    })

    it('refuses an unresolvable base ref', () => {
      const result = validateLoopBranchRequest(git, repoDir, { branch: 'feature/new-work', baseRef: 'origin/missing' })

      expect(result).toEqual({
        ok: false,
        message: `Base ref origin/missing does not resolve to a commit in ${repoDir}; fetch it first`,
      })
    })

    it('refuses invalid branch names', () => {
      for (const branch of ['bad..name', '-x']) {
        expect(validateLoopBranchRequest(git, repoDir, { branch })).toEqual({
          ok: false,
          message: `Invalid branch name "${branch}"`,
        })
      }
    })

    it('refuses the @{-N} shorthand that check-ref-format resolves instead of echoing', () => {
      run(repoDir, 'git checkout -q -b side-branch')
      run(repoDir, 'git checkout -q main')

      expect(validateLoopBranchRequest(git, repoDir, { branch: '@{-1}' })).toEqual({
        ok: false,
        message: 'Invalid branch name "@{-1}"',
      })
    })

    it('refuses a branch checked out in the main checkout', () => {
      expect(validateLoopBranchRequest(git, repoDir, { branch: 'main' })).toEqual({
        ok: false,
        message: `Branch main is checked out in worktree ${repoDir}; choose another branch or free it`,
      })
    })

    it('refuses a branch checked out in another worktree', () => {
      const worktreeDir = join(trackDir('forge-loop-branch-wt-'), 'linked')
      run(repoDir, `git worktree add -q -b linked-branch ${worktreeDir} main`)

      expect(validateLoopBranchRequest(git, repoDir, { branch: 'linked-branch' })).toEqual({
        ok: false,
        message: `Branch linked-branch is checked out in worktree ${worktreeDir}; choose another branch or free it`,
      })
    })

    it('accepts a branch whose worktree directory was deleted without prune', () => {
      const worktreeDir = join(trackDir('forge-loop-branch-wt-'), 'gone')
      run(repoDir, `git worktree add -q -b gone-branch ${worktreeDir} main`)
      rmSync(worktreeDir, { recursive: true, force: true })

      expect(git.worktreeList(repoDir).stdout).toContain('prunable')
      expect(validateLoopBranchRequest(git, repoDir, { branch: 'gone-branch' })).toEqual({ ok: true })
    })

    it('accepts a branch when the worktree list call fails', () => {
      const failing = createFakeGitService({
        checkRefFormatBranch: vi.fn(() => ({ ok: true, status: 0, stdout: 'unlisted-branch', stderr: '' })),
        worktreeList: vi.fn(() => ({ ok: false, status: 128, stdout: '', stderr: 'fatal: not a git repo' })),
      })

      expect(validateLoopBranchRequest(failing, repoDir, { branch: 'unlisted-branch' })).toEqual({ ok: true })
    })

    it('refuses a diverged existing branch', () => {
      run(repoDir, 'git branch diverged-branch')
      run(repoDir, 'git checkout -q diverged-branch')
      commit(repoDir, 'diverged work')
      run(repoDir, 'git checkout -q main')
      commit(repoDir, 'main work')

      expect(validateLoopBranchRequest(git, repoDir, { branch: 'diverged-branch', baseRef: 'main' })).toEqual({
        ok: false,
        message: 'Branch diverged-branch has commits that main does not contain; refusing to reuse it for a loop based on main',
      })
    })

    it('reports an invalid base ref before an invalid branch name', () => {
      const result = validateLoopBranchRequest(git, repoDir, { branch: 'bad..name', baseRef: 'origin/missing' })

      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toContain('does not resolve to a commit')
    })
  })

  describe('git service primitives', () => {
    it('checkRefFormatBranch echoes a valid name and rejects an invalid one', () => {
      expect(git.checkRefFormatBranch(repoDir, 'valid-name').stdout.trim()).toBe('valid-name')
      expect(git.checkRefFormatBranch(repoDir, 'bad..name').ok).toBe(false)
    })

    it('isAncestor is true for equal, ancestor, and false for descendant', () => {
      const head = revParse(repoDir, 'HEAD')
      run(repoDir, 'git branch parent-branch')
      commit(repoDir, 'child')

      expect(git.isAncestor(repoDir, head, head)).toBe(true)
      expect(git.isAncestor(repoDir, 'parent-branch', 'main')).toBe(true)
      expect(git.isAncestor(repoDir, 'main', 'parent-branch')).toBe(false)
    })

    it('branchForceUpdate moves an existing branch non-fast-forward', () => {
      run(repoDir, 'git branch movable-branch')
      commit(repoDir, 'newer main')

      const result = git.branchForceUpdate(repoDir, 'movable-branch', 'main')

      expect(result.ok).toBe(true)
      expect(revParse(repoDir, 'movable-branch')).toBe(revParse(repoDir, 'main'))
    })
  })
})
