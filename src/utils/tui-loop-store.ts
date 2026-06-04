/**
 * Local SQLite-backed loop store for TUI.
 *
 * Provides read-only loop data extracted directly from the same database
 * the server writes to. Replaces the previous bus-rpc backed loops.list/loops.get.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveDataDir } from '../storage'
import { createLoopsRepo } from '../storage/repos/loops-repo'
import { createSectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { LoopInfo } from './tui-models'

function getDbPath(): string {
  return join(resolveDataDir(), 'forge.db')
}

const cap200 = (s: string | null | undefined): string | null =>
  s ? (s.length > 200 ? s.slice(0, 200) : s) : null

function buildSectionViews(rows: Array<{ sectionIndex: number; title: string; status: string; attempts: number; startedAt: number | null; completedAt: number | null; summaryDone: string | null; summaryDeviations: string | null; summaryFollowUps: string | null }>): LoopInfo['sections'] {
  return rows.map((sp) => ({
    index: sp.sectionIndex,
    title: sp.title,
    status: sp.status,
    attempts: sp.attempts,
    startedAt: sp.startedAt,
    completedAt: sp.completedAt,
    summaryDone: cap200(sp.summaryDone),
    summaryDeviations: cap200(sp.summaryDeviations),
    summaryFollowUps: cap200(sp.summaryFollowUps),
  }))
}

function rowToLoopInfo(row: import('../storage/repos/loops-repo').LoopRow, sectionPlans?: Array<import('../storage/repos/section-plans-repo').SectionPlanRow>): LoopInfo {
  const base: LoopInfo = {
    name: row.loopName,
    phase: row.phase,
    iteration: row.iteration,
    maxIterations: row.maxIterations,
    sessionId: row.currentSessionId,
    active: row.status === 'running',
    startedAt: new Date(row.startedAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
    terminationReason: row.terminationReason ?? undefined,
    worktree: row.worktree || undefined,
    worktreeDir: row.worktreeDir,
    worktreeBranch: row.worktreeBranch ?? undefined,
    executionModel: row.executionModel ?? undefined,
    auditorModel: row.auditorModel ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    hostSessionId: row.hostSessionId ?? undefined,
    currentSectionIndex: row.currentSectionIndex,
    totalSections: row.totalSections,
    finalAuditDone: !!row.finalAuditDone,
  }
  if (sectionPlans && sectionPlans.length > 0) {
    return { ...base, sections: buildSectionViews(sectionPlans) }
  }
  return base
}

/**
 * Lists all loops for a project, reading from the local SQLite database.
 * Returns the same shape as the former `rpc('loops.list')`.
 */
export function fetchLoopsList(projectId: string, dbPathOverride?: string): LoopInfo[] {
  const dbPath = dbPathOverride || getDbPath()
  if (!existsSync(dbPath)) return []

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    db.run('PRAGMA busy_timeout=5000')
    const loopsRepo = createLoopsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)

    const rows = loopsRepo.listAll(projectId)
    return rows.map((row) => {
      const plans = sectionPlansRepo.list(projectId, row.loopName)
      return rowToLoopInfo(row, plans.length > 0 ? plans : undefined)
    })
  } catch {
    return []
  } finally {
    try { db?.close() } catch {}
  }
}
