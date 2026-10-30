import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { createForgeWorkspaceAdapter } from '../../src/workspace/forge-adapter'

describe('forge workspace adapter e2e', () => {
  it('full lifecycle: configure -> create -> remove', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-e2e-repo-'))
    const tmpDataDir = mkdtempSync(join(tmpdir(), 'forge-e2e-data-'))

    try {
      execSync('git init && git -c user.name="Forge Test" -c user.email="forge-test@example.invalid" commit --allow-empty -m "init"', {
        cwd: tmpRepo,
        encoding: 'utf-8',
      })

      const mockLogger = {
        log: () => {},
        error: () => {},
        debug: () => {},
      }

      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger: mockLogger,
      })

      const info = {
        id: 'ws-e2e',
        type: 'forge',
        name: '',
        branch: null,
        directory: null,
        extra: { loopName: 'e2e-loop', projectDirectory: tmpRepo },
        projectID: 'p1',
      }

      const configured = await adapter.configure(info)
      expect(configured).toMatchObject({
        name: 'e2e-loop',
        branch: 'forge/e2e-loop',
        directory: join(tmpDataDir, 'worktrees', 'e2e-loop'),
      })

      const worktreeDir = configured.directory!

      expect(existsSync(worktreeDir)).toBe(false)

      await adapter.create(configured, {})
      expect(existsSync(worktreeDir)).toBe(true)

      const headBranch = execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD`, {
        encoding: 'utf-8',
      }).trim()
      expect(headBranch).toBe('forge/e2e-loop')

      await adapter.remove(configured)
      expect(existsSync(worktreeDir)).toBe(false)

      const worktreeList = execSync(`git -C "${tmpRepo}" worktree list`, {
        encoding: 'utf-8',
      })
      expect(worktreeList).not.toContain(worktreeDir)
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
      rmSync(tmpDataDir, { recursive: true, force: true })
    }
  })

  it('recovers from orphan worktree directory: cleans up and retries create', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-e2e-repo-'))
    const tmpDataDir = mkdtempSync(join(tmpdir(), 'forge-e2e-data-'))

    try {
      execSync('git init && git -c user.name="Forge Test" -c user.email="forge-test@example.invalid" commit --allow-empty -m "init"', {
        cwd: tmpRepo,
        encoding: 'utf-8',
      })

      const mockLogger = {
        log: () => {},
        error: () => {},
        debug: () => {},
      }

      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger: mockLogger,
      })

      const info = {
        id: 'ws-orphan',
        type: 'forge',
        name: '',
        branch: null,
        directory: null,
        extra: { loopName: 'orphan-loop', projectDirectory: tmpRepo },
        projectID: 'p1',
      }

      const configured = await adapter.configure(info)
      const worktreeDir = configured.directory!

      // First create succeeds.
      await adapter.create(configured, {})
      expect(existsSync(worktreeDir)).toBe(true)

      // Second create with the same config now must hit "already exists" path.
      // The adapter should clean up the orphan and successfully recreate.
      await adapter.create(configured, {})
      expect(existsSync(worktreeDir)).toBe(true)

      const headBranch = execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD`, {
        encoding: 'utf-8',
      }).trim()
      expect(headBranch).toBe('forge/orphan-loop')

      // Only one entry in worktree list.
      const worktreeList = execSync(`git -C "${tmpRepo}" worktree list`, {
        encoding: 'utf-8',
      })
      const matches = worktreeList.split('\n').filter(line => line.includes(worktreeDir))
      expect(matches.length).toBe(1)

      await adapter.remove(configured)
      expect(existsSync(worktreeDir)).toBe(false)
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
      rmSync(tmpDataDir, { recursive: true, force: true })
    }
  })

  it('runs a loop on a caller branch based on a remote ref and continues it on restart', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-e2e-repo-'))
    const tmpDataDir = mkdtempSync(join(tmpdir(), 'forge-e2e-data-'))

    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m "init"', {
        cwd: tmpRepo,
        encoding: 'utf-8',
      })

      const branchName = 'pm-61-export'
      execSync(`git branch ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' })

      writeFileSync(join(tmpRepo, 'origin.txt'), 'origin', 'utf-8')
      execSync('git add origin.txt && git commit -m "origin ahead"', { cwd: tmpRepo, encoding: 'utf-8' })
      execSync(`git update-ref refs/remotes/origin/${branchName} HEAD`, { cwd: tmpRepo, encoding: 'utf-8' })
      execSync('git reset --hard HEAD~1', { cwd: tmpRepo, encoding: 'utf-8' })

      const originTip = execSync(`git rev-parse refs/remotes/origin/${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      const localTipBefore = execSync(`git rev-parse ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      expect(localTipBefore).not.toBe(originTip)

      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger: { log: () => {}, error: () => {}, debug: () => {} },
        getTeardownContext: () => ({ iteration: 1, reasonLabel: 'completed', doCommit: true, doRemoveWorktree: true }),
      })

      const info = {
        id: 'ws-custom-branch',
        type: 'forge',
        name: '',
        branch: null,
        directory: null,
        extra: { loopName: 'custom-branch-loop', projectDirectory: tmpRepo, branch: branchName, baseRef: `origin/${branchName}` },
        projectID: 'p1',
      }

      const configured = await adapter.configure(info)
      expect(configured.branch).toBe(branchName)

      await adapter.create(configured)
      const worktreeDir = configured.directory!

      const headBranch = execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD`, { encoding: 'utf-8' }).trim()
      expect(headBranch).toBe(branchName)
      const headTip = execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: 'utf-8' }).trim()
      expect(headTip).toBe(originTip)

      execSync('git config user.email t@t && git config user.name t', { cwd: worktreeDir, encoding: 'utf-8' })
      writeFileSync(join(worktreeDir, 'work.txt'), 'work', 'utf-8')

      await adapter.remove(configured)
      expect(existsSync(worktreeDir)).toBe(false)

      const teardownTip = execSync(`git rev-parse ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      expect(teardownTip).not.toBe(originTip)
      const logSubjects = execSync(`git log ${branchName} --format=%s`, { cwd: tmpRepo, encoding: 'utf-8' })
      expect(logSubjects).toMatch(/loop: custom-branch-loop completed after 1 iteration/)
      const committedFiles = execSync(`git ls-tree --name-only ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' })
        .split('\n')
        .map((line) => line.trim())
      expect(committedFiles).toContain('work.txt')

      const reconfigured = await adapter.configure({
        id: 'ws-custom-branch',
        type: 'forge',
        name: '',
        branch: null,
        directory: null,
        extra: { loopName: 'custom-branch-loop', projectDirectory: tmpRepo, branch: branchName },
        projectID: 'p1',
      })

      await adapter.create(reconfigured)

      const restartedTip = execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: 'utf-8' }).trim()
      expect(restartedTip).toBe(teardownTip)
      const restartedBranch = execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD`, { encoding: 'utf-8' }).trim()
      expect(restartedBranch).toBe(branchName)

      const originTipAfter = execSync(`git rev-parse refs/remotes/origin/${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      expect(originTipAfter).toBe(originTip)
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
      rmSync(tmpDataDir, { recursive: true, force: true })
    }
  })
})
