import { join, resolve } from 'path'
import { existsSync, rmSync } from 'fs'
import type { Logger } from '../types'
import { defaultGitService, type GitService } from './git-service'

interface WorktreeCleanupInput {
  worktreeDir: string
  logPrefix: string
  logger: Logger | Console
  git?: GitService
}

interface WorktreeCleanupResult {
  removed: boolean
  error?: string
}

export async function cleanupLoopWorktree(
  input: WorktreeCleanupInput,
): Promise<WorktreeCleanupResult> {
  const git = input.git ?? defaultGitService
  const result: WorktreeCleanupResult = {
    removed: false,
  }

  try {
    if (!existsSync(input.worktreeDir)) {
      result.removed = true
      input.logger.log(`${input.logPrefix}: worktree directory already removed ${input.worktreeDir}`)
      try {
        const common = git.revParseGitCommonDir(input.worktreeDir)
        if (common.ok) {
          const gitRoot = resolve(input.worktreeDir, common.stdout.trim(), '..')
          git.worktreePrune(gitRoot)
        }
      } catch {
        // best-effort prune from parent dir if possible
      }
      return result
    }

    if (!existsSync(join(input.worktreeDir, '.git'))) {
      rmSync(input.worktreeDir, { recursive: true, force: true })
      result.removed = true
      input.logger.log(`${input.logPrefix}: removed non-git worktree directory ${input.worktreeDir}`)
      return result
    }

    const common = git.revParseGitCommonDir(input.worktreeDir)
    if (!common.ok) {
      if (isNotGitRepositoryError(common.stderr)) {
        rmSync(input.worktreeDir, { recursive: true, force: true })
        result.removed = true
        input.logger.log(`${input.logPrefix}: removed non-git worktree directory ${input.worktreeDir}`)
        return result
      }
      throw new Error(common.stderr || 'git rev-parse --git-common-dir failed')
    }
    const gitRoot = resolve(input.worktreeDir, common.stdout.trim(), '..')
    const removeResult = git.worktreeRemove(gitRoot, input.worktreeDir)
    if (!removeResult.ok) {
      const stderr = removeResult.stderr || ''
      if (/Permission denied/.test(stderr) && !existsSync(input.worktreeDir)) {
        result.removed = true
        input.logger.log(`${input.logPrefix}: worktree directory already removed (permission denied during remove)`)
        git.worktreePrune(gitRoot)
        return result
      }
      throw new Error(removeResult.stderr || 'git worktree remove failed')
    }

    result.removed = true
    input.logger.log(`${input.logPrefix}: removed worktree ${input.worktreeDir}`)

    git.worktreePrune(gitRoot)

  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    input.logger.error(`${input.logPrefix}: failed to cleanup worktree`, err)
  }

  return result
}

function isNotGitRepositoryError(message: string): boolean {
  return /not a git repository/i.test(message)
}
