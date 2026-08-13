import { join } from 'path'
import { existsSync, rmSync } from 'fs'
import type { Logger } from '../types'
import type { GitService } from '../utils/git-service'
import { WORKTREE_OPENCODE_CONFIG_FILENAME } from './worktree-opencode-config'

export type WorktreeCommitOutcome = 'committed' | 'no-changes' | 'failed'

/**
 * Remove the forge-written `opencode.jsonc` before committing so the inline
 * per-loop config never enters loop history. Only an untracked file is
 * removed: when the repository already tracks an `opencode.jsonc`, forge never
 * wrote it (skip-if-exists), so it is left untouched and its edits still commit.
 */
function removeForgeWrittenOpencodeConfig(git: GitService, logger: Logger, directory: string): void {
  const configPath = join(directory, WORKTREE_OPENCODE_CONFIG_FILENAME)
  if (!existsSync(configPath)) return
  if (git.isPathTracked(directory, WORKTREE_OPENCODE_CONFIG_FILENAME)) return
  try {
    rmSync(configPath, { force: true })
    logger.log(`worktree-commit: removed forge-written ${WORKTREE_OPENCODE_CONFIG_FILENAME} before commit in ${directory}`)
  } catch (err) {
    logger.log(`worktree-commit: could not remove ${WORKTREE_OPENCODE_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Single point of truth for committing a forge worktree's pending changes:
 * strips the forge-written opencode config, stages everything, and commits.
 * Used by both the teardown commit (forge-adapter) and the per-section
 * checkpoint commits (loop runtime). Failures are logged, never thrown — a
 * missed commit degrades bookkeeping, it must not break the caller.
 */
export function commitWorktreeChanges(git: GitService, logger: Logger, directory: string, message: string): WorktreeCommitOutcome {
  removeForgeWrittenOpencodeConfig(git, logger, directory)

  const addResult = git.addAll(directory)
  if (!addResult.ok) {
    logger.log(`worktree-commit: git add failed in ${directory}: ${addResult.stderr.trim() || 'unknown error'}`)
    return 'failed'
  }

  const statusResult = git.statusPorcelain(directory)
  if (!statusResult.ok) {
    logger.log(`worktree-commit: git status failed in ${directory}: ${statusResult.stderr.trim() || 'unknown error'}`)
    return 'failed'
  }
  if (!statusResult.stdout.trim()) {
    return 'no-changes'
  }

  const commitResult = git.commit(directory, message)
  if (!commitResult.ok) {
    logger.log(`worktree-commit: commit failed in ${directory}: ${commitResult.stderr.trim() || 'unknown error'}`)
    return 'failed'
  }
  return 'committed'
}
