import { join } from 'path'
import { existsSync, rmSync } from 'fs'
import type { Logger } from '../types'
import type { GitService } from '../utils/git-service'
import { WORKTREE_OPENCODE_CONFIG_FILENAME } from './worktree-opencode-config'
import { CODE_GRAPH_LINK_NAME } from '../constants/loop'
import { isForgeCodeGraphLink } from '../loop/code-graph'

export type WorktreeCommitOutcome = 'committed' | 'no-changes' | 'failed'

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

export function commitWorktreeChanges(git: GitService, logger: Logger, directory: string, message: string): WorktreeCommitOutcome {
  removeForgeWrittenOpencodeConfig(git, logger, directory)

  const addResult = git.addAll(directory)
  if (!addResult.ok) {
    logger.log(`worktree-commit: git add failed in ${directory}: ${addResult.stderr.trim() || 'unknown error'}`)
    return 'failed'
  }

  if (isForgeCodeGraphLink(directory)) {
    const unstaged = git.removeFromIndex(directory, CODE_GRAPH_LINK_NAME)
    if (!unstaged.ok) {
      logger.log(`worktree-commit: could not keep ${CODE_GRAPH_LINK_NAME} out of the commit in ${directory}: ${unstaged.stderr.trim() || 'unknown error'}`)
      return 'failed'
    }
  }

  const statusResult = git.statusPorcelain(directory)
  if (!statusResult.ok) {
    logger.log(`worktree-commit: git status failed in ${directory}: ${statusResult.stderr.trim() || 'unknown error'}`)
    return 'failed'
  }
  const staged = statusResult.stdout.split('\n').filter((line) => line.trim() && !line.startsWith('??'))
  if (staged.length === 0) {
    return 'no-changes'
  }

  const commitResult = git.commit(directory, message)
  if (!commitResult.ok) {
    logger.log(`worktree-commit: commit failed in ${directory}: ${commitResult.stderr.trim() || 'unknown error'}`)
    return 'failed'
  }
  return 'committed'
}
