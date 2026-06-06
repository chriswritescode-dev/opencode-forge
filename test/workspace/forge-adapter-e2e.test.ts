import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { createForgeWorkspaceAdapter } from '../../src/workspace/forge-adapter'

describe('forge workspace adapter e2e', () => {
  it('full lifecycle: configure -> create -> target -> remove', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-e2e-repo-'))
    const tmpDataDir = mkdtempSync(join(tmpdir(), 'forge-e2e-data-'))

    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m "init"', {
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

      const target = adapter.target(configured)
      expect(target).toEqual({ type: 'local', directory: worktreeDir })

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
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m "init"', {
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
})
