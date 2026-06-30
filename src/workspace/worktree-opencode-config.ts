import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import type { Logger } from '../types'

/** Filename forge writes the inline opencode config to inside a worktree. */
export const WORKTREE_OPENCODE_CONFIG_FILENAME = 'opencode.jsonc'

/** Filenames opencode discovers as a project config; any present means "already configured". */
const OPENCODE_CONFIG_FILENAMES = ['opencode.jsonc', 'opencode.json'] as const

type WriteWorktreeOpencodeConfigReason = 'no-config' | 'exists' | 'written' | 'error'

export interface WriteWorktreeOpencodeConfigInput {
  /** Absolute worktree root directory. */
  directory: string
  /** Inline config object from `loop.worktreeOpencodeConfig` (may be undefined/empty). */
  config: Record<string, unknown> | undefined
  logger: Logger
}

export interface WriteWorktreeOpencodeConfigResult {
  written: boolean
  reason: WriteWorktreeOpencodeConfigReason
  /** Path written when `written` is true; undefined otherwise. */
  path?: string
}

/**
 * Write the inline opencode config into a worktree as `opencode.jsonc`.
 * Skip-if-exists (never overwrites a committed opencode config) and non-fatal:
 * any failure is logged and reported via `reason: 'error'`, never thrown.
 */
export function writeWorktreeOpencodeConfig(
  input: WriteWorktreeOpencodeConfigInput,
): WriteWorktreeOpencodeConfigResult {
  const { directory, config, logger } = input
  if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
    return { written: false, reason: 'no-config' }
  }
  const existing = OPENCODE_CONFIG_FILENAMES.find((name) => existsSync(join(directory, name)))
  if (existing) {
    logger.log(`worktree-opencode-config: ${existing} already present in ${directory}; skipping`)
    return { written: false, reason: 'exists' }
  }
  const target = join(directory, WORKTREE_OPENCODE_CONFIG_FILENAME)
  try {
    writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf-8')
    logger.log(`worktree-opencode-config: wrote ${WORKTREE_OPENCODE_CONFIG_FILENAME} in ${directory}`)
    return { written: true, reason: 'written', path: target }
  } catch (err) {
    logger.log(
      `worktree-opencode-config: failed to write ${WORKTREE_OPENCODE_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { written: false, reason: 'error' }
  }
}
