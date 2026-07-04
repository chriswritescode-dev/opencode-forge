import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createGitService, type GitService } from '../../src/utils/git-service'
import { join } from 'path'
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'

describe('GitService', () => {
  let repo: string
  let nonRepo: string
  let git: GitService

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-svc-'))
    execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: repo, encoding: 'utf-8' })
    nonRepo = mkdtempSync(join(tmpdir(), 'git-svc-nonrepo-'))
    git = createGitService()
  })

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true })
    if (existsSync(nonRepo)) rmSync(nonRepo, { recursive: true, force: true })
  })

  describe('isInsideWorkTree', () => {
    it('returns true for a git repo', () => {
      expect(git.isInsideWorkTree(repo)).toBe(true)
    })

    it('returns false for a non-repo directory', () => {
      expect(git.isInsideWorkTree(nonRepo)).toBe(false)
    })
  })

  describe('currentBranch', () => {
    it('returns non-empty string for a repo', () => {
      const branch = git.currentBranch(repo)
      expect(branch).toBeTruthy()
      expect(typeof branch).toBe('string')
    })

    it('returns null for a non-repo directory', () => {
      expect(git.currentBranch(nonRepo)).toBeNull()
    })
  })

  describe('branchExists', () => {
    it('returns true for the current branch', () => {
      const branch = git.currentBranch(repo)!
      expect(git.branchExists(repo, branch)).toBe(true)
    })

    it('returns false for a non-existent branch', () => {
      expect(git.branchExists(repo, 'forge/does-not-exist')).toBe(false)
    })

    it('returns false for empty cwd', () => {
      expect(git.branchExists('', 'x')).toBe(false)
    })
  })

  describe('revParseGitCommonDir', () => {
    it('returns ok for a git repo', () => {
      const result = git.revParseGitCommonDir(repo)
      expect(result.ok).toBe(true)
      expect(result.stdout).toBeTruthy()
    })

    it('returns not ok for a non-repo directory', () => {
      const result = git.revParseGitCommonDir(nonRepo)
      expect(result.ok).toBe(false)
      expect(result.stderr).toMatch(/not a git repository/i)
    })
  })

  describe('revParseGitDir', () => {
    it('returns not ok for a nonexistent directory (spawn failure)', () => {
      const result = git.revParseGitDir('/nonexistent-dir-xyz')
      expect(result.ok).toBe(false)
      expect(result.status).not.toBe(0)
    })
  })

  describe('worktreeAdd / worktreeRemove', () => {
    it('adds and removes a worktree', () => {
      const rand = String(Math.random()).slice(2)
      const wtDir = join(repo, '..', `wt-${rand}`)
      try {
        const addResult = git.worktreeAdd(repo, wtDir, 'forge/wt', true)
        expect(addResult.ok).toBe(true)
        expect(existsSync(wtDir)).toBe(true)

        const removeResult = git.worktreeRemove(repo, wtDir)
        expect(removeResult.ok).toBe(true)
        expect(existsSync(wtDir)).toBe(false)
      } finally {
        if (existsSync(wtDir)) rmSync(wtDir, { recursive: true, force: true })
      }
    })
  })

  describe('addAll / statusPorcelain / commit roundtrip', () => {
    it('stages, shows status, commits, and confirms clean', () => {
      writeFileSync(join(repo, 'test.txt'), 'hello', 'utf-8')

      const addResult = git.addAll(repo)
      expect(addResult.ok).toBe(true)

      const statusResult = git.statusPorcelain(repo)
      expect(statusResult.ok).toBe(true)
      expect(statusResult.stdout).toBeTruthy()

      const commitResult = git.commit(repo, 'test commit')
      expect(commitResult.ok).toBe(true)

      const cleanStatus = git.statusPorcelain(repo)
      expect(cleanStatus.ok).toBe(true)
      expect(cleanStatus.stdout.trim()).toBe('')
    })
  })

  describe('isPathTracked', () => {
    it('returns true for a committed (tracked) file', () => {
      writeFileSync(join(repo, 'tracked.txt'), 'x', 'utf-8')
      execSync('git add tracked.txt && git commit -m add', { cwd: repo, encoding: 'utf-8' })
      expect(git.isPathTracked(repo, 'tracked.txt')).toBe(true)
    })

    it('returns false for an untracked file', () => {
      writeFileSync(join(repo, 'untracked.txt'), 'x', 'utf-8')
      expect(git.isPathTracked(repo, 'untracked.txt')).toBe(false)
    })

    it('returns false for a missing path', () => {
      expect(git.isPathTracked(repo, 'nope.txt')).toBe(false)
    })
  })

  describe('worktreePrune', () => {
    it('returns ok', () => {
      const result = git.worktreePrune(repo)
      expect(result.ok).toBe(true)
    })
  })

  describe('revParseHead', () => {
    it('returns 40-char SHA of HEAD', () => {
      const result = git.revParseHead(repo)
      expect(result.ok).toBe(true)
      expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    })

    it('returns not-ok for a non-repo directory', () => {
      const result = git.revParseHead(nonRepo)
      expect(result.ok).toBe(false)
    })
  })

  describe('commitExists', () => {
    it('returns true for the HEAD SHA', () => {
      const headResult = git.revParseHead(repo)
      const sha = headResult.stdout.trim()
      expect(git.commitExists(repo, sha)).toBe(true)
    })

    it('returns false for a bogus SHA', () => {
      expect(git.commitExists(repo, '0'.repeat(40))).toBe(false)
    })
  })

  describe('push', () => {
    let bare: string

    beforeEach(() => {
      bare = mkdtempSync(join(tmpdir(), 'git-svc-bare-'))
      execSync('git init --bare', { cwd: bare, encoding: 'utf-8' })
    })

    afterEach(() => {
      if (existsSync(bare)) rmSync(bare, { recursive: true, force: true })
    })

    it('pushes HEAD to remote and ref shows up; force-push after new commit succeeds', () => {
      // Add remote and push
      execSync(`git remote add origin ${bare}`, { cwd: repo, encoding: 'utf-8' })
      const pushResult = git.push(repo, 'origin', 'HEAD:refs/forge/test-loop', false)
      expect(pushResult.ok).toBe(true)

      // Verify ref exists in bare repo
      const showRef = execSync(`git --git-dir=${bare} show-ref refs/forge/test-loop`, { encoding: 'utf-8' })
      expect(showRef.trim()).toMatch(/^[0-9a-f]{40} refs\/forge\/test-loop$/)

      // New commit + force push
      execSync('git commit --allow-empty -m second', { cwd: repo, encoding: 'utf-8' })
      const forceResult = git.push(repo, 'origin', 'HEAD:refs/forge/test-loop', true)
      expect(forceResult.ok).toBe(true)
    })
  })

  describe('fetchRef', () => {
    let bare: string
    let clone: string

    beforeEach(() => {
      bare = mkdtempSync(join(tmpdir(), 'git-svc-bare2-'))
      execSync('git init --bare', { cwd: bare, encoding: 'utf-8' })
      execSync(`git remote add origin ${bare}`, { cwd: repo, encoding: 'utf-8' })
      execSync('git push origin HEAD', { cwd: repo, encoding: 'utf-8' })

      clone = mkdtempSync(join(tmpdir(), 'git-svc-clone-'))
      execSync(`git clone ${bare} ${clone}`, { encoding: 'utf-8' })
    })

    afterEach(() => {
      if (existsSync(bare)) rmSync(bare, { recursive: true, force: true })
      if (existsSync(clone)) rmSync(clone, { recursive: true, force: true })
    })

    it('fetches a ref so commitExists returns true in the clone', () => {
      // Create a new commit and push a specific ref from the original repo
      execSync('git commit --allow-empty -m for-fetch', { cwd: repo, encoding: 'utf-8' })
      const headSha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim()
      execSync(`git push origin HEAD:refs/forge/x`, { cwd: repo, encoding: 'utf-8' })

      // Fetch into clone
      const fetchResult = git.fetchRef(clone, 'origin', 'refs/forge/x')
      expect(fetchResult.ok).toBe(true)

      // Commit should now be reachable in clone
      expect(git.commitExists(clone, headSha)).toBe(true)
    })
  })

  describe('worktreeAdd with startPoint', () => {
    it('creates a worktree pinned to a specific commit', () => {
      // Create two commits so we can pin to the first
      const firstSha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim()
      execSync('git commit --allow-empty -m second', { cwd: repo, encoding: 'utf-8' })

      const rand = String(Math.random()).slice(2)
      const wtDir = join(repo, '..', `wt-pin-${rand}`)
      try {
        const addResult = git.worktreeAdd(repo, wtDir, 'forge/pin-test', true, firstSha)
        expect(addResult.ok).toBe(true)
        expect(existsSync(wtDir)).toBe(true)

        const wtHead = execSync('git rev-parse HEAD', { cwd: wtDir, encoding: 'utf-8' }).trim()
        expect(wtHead).toBe(firstSha)
      } finally {
        if (existsSync(wtDir)) rmSync(wtDir, { recursive: true, force: true })
      }
    })
  })
})
