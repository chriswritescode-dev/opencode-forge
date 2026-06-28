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

  describe('worktreePrune', () => {
    it('returns ok', () => {
      const result = git.worktreePrune(repo)
      expect(result.ok).toBe(true)
    })
  })
})
