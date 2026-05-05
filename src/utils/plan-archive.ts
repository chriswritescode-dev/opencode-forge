import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { resolveDataDir } from '../storage/database'
import { extractPlanTitle } from './plan-execution'

/** SHA-256 hex digest of the raw plan bytes. Used as the archive filename (without extension). */
export function hashPlanContent(planText: string): string {
  return createHash('sha256').update(planText, 'utf8').digest('hex')
}

/** Default TTL for archived plans: 7 days. */
export const DEFAULT_PLAN_ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface ArchivedPlan {
  filename: string      // basename only
  filepath: string      // absolute
  title: string         // extractPlanTitle(content)
  modifiedAt: number    // statSync.mtimeMs
}

/**
 * Returns the absolute path to the plan archive directory for a project.
 */
export function resolvePlanArchiveDir(projectId: string): string {
  return join(resolveDataDir(), 'plans', projectId)
}

/**
 * Builds a filename for an archived plan.
 * Filename is derived from a SHA-256 of the plan content; the timestamp argument is retained only for backward compatibility and is ignored.
 * Format: <sha256-hex>.md
 */
export function buildPlanArchiveFilename(planText: string, _now: Date = new Date()): string {
  return `${hashPlanContent(planText)}.md`
}

/**
 * Saves a plan to the archive directory for a project.
 * Creates the directory if it doesn't exist.
 * Prunes plans older than `ttlMs` after writing (best-effort, non-throwing).
 * Returns the filepath, filename, pruned count, and deduped flag.
 */
export function savePlanToArchive(
  projectId: string,
  planText: string,
  now: Date = new Date(),
  ttlMs: number = DEFAULT_PLAN_ARCHIVE_TTL_MS,
): { filepath: string; filename: string; pruned: number; deduped: boolean } {
  const dir = resolvePlanArchiveDir(projectId)
  mkdirSync(dir, { recursive: true })
  const filename = buildPlanArchiveFilename(planText, now)
  const filepath = join(dir, filename)
  let deduped = false
  if (existsSync(filepath)) {
    deduped = true
  } else {
    writeFileSync(filepath, planText, 'utf-8')
  }
  const pruned = prunePlanArchive(projectId, ttlMs, now)
  return { filepath, filename, pruned, deduped }
}

/**
 * Deletes archived plans whose mtime is older than `ttlMs` from `now`.
 * `ttlMs <= 0` disables pruning. Best-effort: per-entry failures are logged and skipped.
 * Returns the number of files removed.
 */
export function prunePlanArchive(
  projectId: string,
  ttlMs: number,
  now: Date = new Date(),
): number {
  if (ttlMs <= 0) return 0
  const dir = resolvePlanArchiveDir(projectId)
  if (!existsSync(dir)) return 0

  const cutoff = now.getTime() - ttlMs
  let removed = 0
  for (const f of readdirSync(dir)) {
    if (!/^[0-9a-f]{64}\.md$/.test(f)) continue
    const filepath = join(dir, f)
    try {
      const stat = statSync(filepath)
      if (!stat.isFile()) continue
      if (stat.mtimeMs < cutoff) {
        unlinkSync(filepath)
        removed++
      }
    } catch (err) {
      console.error(`[forge] failed to prune plan archive entry ${filepath}`, err)
    }
  }
  return removed
}

/**
 * Lists all archived plans for a project, sorted by modifiedAt descending (newest first).
 * Returns an empty array if the directory doesn't exist.
 */
export function listArchivedPlans(projectId: string): ArchivedPlan[] {
  const dir = resolvePlanArchiveDir(projectId)
  if (!existsSync(dir)) {
    return []
  }

  const entries: ArchivedPlan[] = []
  for (const f of readdirSync(dir)) {
    if (!/^[0-9a-f]{64}\.md$/.test(f)) continue
    const filepath = join(dir, f)
    try {
      const stat = statSync(filepath)
      if (!stat.isFile()) continue
      const content = readFileSync(filepath, 'utf-8')
      entries.push({
        filename: f,
        filepath,
        title: extractPlanTitle(content),
        modifiedAt: stat.mtimeMs,
      })
    } catch (err) {
      console.error(`[forge] skipping unreadable plan archive entry ${filepath}`, err)
    }
  }

  entries.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return entries
}

/**
 * Reads an archived plan file and returns its content.
 */
export function readArchivedPlan(filepath: string): string {
  return readFileSync(filepath, 'utf-8')
}
