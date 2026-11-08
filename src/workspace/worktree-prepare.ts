import { existsSync, readFileSync, appendFileSync } from 'fs'
import type { Logger } from '../types'
import type { GitService } from '../utils/git-service'
import { writeWorktreeOpencodeConfig, WORKTREE_OPENCODE_CONFIG_FILENAME } from './worktree-opencode-config'
import { CODE_GRAPH_LINK_NAME } from '../constants/loop'

export interface PrepareForgeWorktreeOptions {
  /** Git seam used to resolve the worktree's exclude file. */
  git: GitService
  /** Logger for the prepare step's diagnostics. */
  logger: Logger
  /** Inline opencode config written into the worktree as `opencode.jsonc` (skip-if-exists). */
  worktreeOpencodeConfig?: Record<string, unknown>
  /** Sandbox container name substituted into the written config, when a sandbox will be provisioned. */
  sandboxContainerName?: string
  /** Whether a provisioned sandbox links `CODE_GRAPH_LINK_NAME` into the worktree, so it must be excluded. */
  excludeCodeGraphLink?: boolean
}

/**
 * Idempotently appends `patterns` to the worktree's git `info/exclude` so they never enter loop
 * commits. Non-fatal: a failed `git rev-parse` or file write is logged and skipped.
 */
function addToGitExclude(git: GitService, logger: Logger, directory: string, patterns: string[]): void {
  if (patterns.length === 0) return
  const excludeRes = git.revParseGitPath(directory, 'info/exclude')
  if (!excludeRes.ok || !excludeRes.stdout) return
  const excludeFile = excludeRes.stdout.trim()
  try {
    const content = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : ''
    const present = new Set(content.split('\n').map((l) => l.trim()))
    const missing = patterns.filter((p) => !present.has(p))
    if (missing.length > 0) {
      appendFileSync(excludeFile, `\n${missing.join('\n')}\n`)
      logger.log(`worktree-prepare: added ${missing.join(', ')} to git exclude in ${directory}`)
    }
  } catch (err) {
    logger.log(`worktree-prepare: could not update git exclude: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Per-worktree preparation after `git worktree add`: write the inline opencode config when
 * configured, then idempotently add `.forge/`, the sandbox code-graph link, and any forge-written
 * opencode config to the worktree's git exclude so they never enter loop commits.
 */
export function prepareForgeWorktree(directory: string, opts: PrepareForgeWorktreeOptions): void {
  const { git, logger } = opts
  const excludePatterns = ['.forge/']
  if (opts.excludeCodeGraphLink === true) {
    excludePatterns.push(CODE_GRAPH_LINK_NAME)
  }
  const cfgResult = writeWorktreeOpencodeConfig({
    directory,
    config: opts.worktreeOpencodeConfig,
    sandboxContainerName: opts.sandboxContainerName,
    logger,
  })
  if (cfgResult.written) {
    excludePatterns.push(WORKTREE_OPENCODE_CONFIG_FILENAME)
  }
  addToGitExclude(git, logger, directory, excludePatterns)
}
