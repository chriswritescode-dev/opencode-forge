import { cpSync, existsSync, statSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { spawnSync } from 'child_process'
import { resolveConfigDir } from '../setup'
import type { Logger } from '../types'

export interface MaterializeSkillsOptions {
  worktreeDir: string
  skills: string[]
  sourceSkillsDir?: string
  logger?: Pick<Logger, 'log' | 'error'>
  resolveExcludePath?: (worktreeDir: string) => string | null
}

export interface MaterializeSkillsResult {
  copied: string[]
  missing: string[]
}

/**
 * Copies requested skills from a source skills directory into `{worktreeDir}/.opencode/skills/`.
 * Rejects names containing `/`, `\`, or `..`. After copying, ensures the git exclude file
 * contains `.opencode/skills/` so the copied files are not accidentally tracked.
 */
export function materializeSkillsIntoWorktree(opts: MaterializeSkillsOptions): MaterializeSkillsResult {
  const { worktreeDir, skills, logger } = opts

  if (skills.length === 0) {
    return { copied: [], missing: [] }
  }

  const sourceSkillsDir = opts.sourceSkillsDir ?? join(resolveConfigDir(), 'skills')
  const copied: string[] = []
  const missing: string[] = []

  for (const name of skills) {
    const trimmed = name.trim()

    // Reject unsafe names
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
      missing.push(trimmed || name)
      continue
    }

    const src = join(sourceSkillsDir, trimmed)

    if (existsSync(src) && statSync(src).isDirectory()) {
      const dest = join(worktreeDir, '.opencode', 'skills', trimmed)
      try {
        cpSync(src, dest, { recursive: true })
        copied.push(trimmed)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger?.error(`[skill-materializer] Failed to copy skill "${trimmed}": ${message}`)
        missing.push(trimmed)
      }
    } else {
      missing.push(trimmed)
    }
  }

  if (copied.length > 0) {
    ensureGitExclude(worktreeDir, opts.resolveExcludePath)
  }

  return { copied, missing }
}

function defaultResolveExcludePath(worktreeDir: string): string | null {
  const result = spawnSync('git', ['-C', worktreeDir, 'rev-parse', '--git-path', 'info/exclude'], {
    encoding: 'utf-8',
  })

  if (result.status !== 0) {
    return null
  }

  const relativePath = result.stdout.trim()
  if (!relativePath) {
    return null
  }

  if (relativePath.startsWith('/')) {
    return relativePath
  }

  return resolve(worktreeDir, relativePath)
}

function ensureGitExclude(
  worktreeDir: string,
  resolveExcludePath?: (worktreeDir: string) => string | null,
): void {
  const excludePath = resolveExcludePath
    ? resolveExcludePath(worktreeDir)
    : defaultResolveExcludePath(worktreeDir)

  if (!excludePath) {
    return
  }

  mkdirSync(dirname(excludePath), { recursive: true })

  const line = '.opencode/skills/'

  if (existsSync(excludePath)) {
    const existing = readFileSync(excludePath, 'utf-8')
    const lines = existing.split('\n')
    if (lines.some((l) => l.trim() === line)) {
      return // already present, idempotent
    }
    appendFileSync(excludePath, `\n${line}\n`, 'utf-8')
  } else {
    writeFileSync(excludePath, `${line}\n`, 'utf-8')
  }
}
