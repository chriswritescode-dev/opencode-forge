/**
 * Local SQLite-backed loop store for TUI.
 *
 * Provides read-only loop data extracted directly from the same database
 * the server writes to. Replaces the previous bus-rpc backed loops.list/loops.get.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { randomUUID } from 'node:crypto'
import { resolveForgeDbPath } from '../storage'
import { createLoopsRepo } from '../storage/repos/loops-repo'
import { createPlansRepo } from '../storage/repos/plans-repo'
import { createSectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { LoopInfo } from './tui-models'
import { createTuiLoopRestartRepo, type TuiLoopRestartAppliedState } from '../storage/repos/tui-loop-restart-repo'
import { getRestartability } from '../loop/restartability'
import { loopBranchExists } from '../workspace/forge-naming'

/**
 * Opens the forge database read-only, runs `read`, and always closes the
 * handle. Returns `fallback` when the file is missing or any step throws: the
 * TUI renders whatever it can rather than surfacing a database error.
 */
function withReadOnlyForgeDb<T>(dbPathOverride: string | undefined, fallback: T, read: (db: Database) => T): T {
  const dbPath = dbPathOverride || resolveForgeDbPath()
  if (!existsSync(dbPath)) return fallback

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    db.run('PRAGMA busy_timeout=5000')
    return read(db)
  } catch {
    return fallback
  } finally {
    try { db?.close() } catch {}
  }
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
  const restartability = getRestartability({
    loopName: row.loopName,
    status: row.status,
    terminationReason: row.terminationReason,
    worktree: row.worktree,
    worktreeDir: row.worktreeDir,
    active: row.status === 'running',
  }, {
    branchExists: () => loopBranchExists(row, row.projectDir),
  })
  const base: LoopInfo = {
    name: row.loopName,
    status: row.status,
    phase: row.phase,
    iteration: row.iteration,
    maxIterations: row.maxIterations,
    sessionId: row.currentSessionId,
    active: row.status === 'running',
    restartable: restartability.restartable,
    restartRequiresForce: restartability.restartRequiresForce,
    restartBlockedMessage: restartability.restartBlockedMessage,
    startedAt: new Date(row.startedAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
    terminationReason: row.terminationReason ?? undefined,
    worktree: row.worktree || undefined,
    worktreeDir: row.worktreeDir,
    worktreeBranch: row.worktreeBranch ?? undefined,
    executionModel: row.executionModel ?? undefined,
    auditorModel: row.auditorModel ?? undefined,
    auditorVariant: row.auditorVariant ?? undefined,
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
  return withReadOnlyForgeDb(dbPathOverride, [], (db) => {
    const loopsRepo = createLoopsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)

    return loopsRepo.listAll(projectId).map((row) => {
      const plans = sectionPlansRepo.list(projectId, row.loopName)
      return rowToLoopInfo(row, plans.length > 0 ? plans : undefined)
    })
  })
}

/**
 * Reads the session-scoped stored plan for the TUI execute-plan dialog.
 * Returns null when the database, row, or content is absent.
 */
export function fetchStoredSessionPlan(projectId: string, sessionId: string, dbPathOverride?: string): string | null {
  return withReadOnlyForgeDb(dbPathOverride, null, (db) =>
    createPlansRepo(db).getForSession(projectId, sessionId)?.content ?? null
  )
}

function openWritableForgeDb(dbPathOverride?: string): Database {
  const dbPath = dbPathOverride || resolveForgeDbPath()
  if (!existsSync(dbPath)) throw new Error('Forge database is unavailable')
  const db = new Database(dbPath, { readwrite: true, create: false })
  try {
    db.run('PRAGMA busy_timeout=5000')
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

function waitForRestartPoll(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function requestTuiLoopRestart(
  projectId: string,
  request: { loopName: string; auditorModel: string; auditorVariant: string },
  opts: { dbPath?: string; timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<TuiLoopRestartAppliedState> {
  if (opts.signal?.aborted) throw new Error('Loop restart cancelled')
  const revision = randomUUID()
  const writeDb = openWritableForgeDb(opts.dbPath)
  try {
    const accepted = createTuiLoopRestartRepo(writeDb).trySetDesired(projectId, {
      version: 1,
      revision,
      loopName: request.loopName,
      auditorModel: request.auditorModel,
      auditorVariant: request.auditorVariant,
      requestedAt: Date.now(),
    })
    if (!accepted) throw new Error('Another loop restart request is already in progress')
  } finally {
    writeDb.close()
  }

  const startedAt = Date.now()
  const timeoutMs = opts.timeoutMs ?? 35_000
  const pollMs = opts.pollMs ?? 100
  while (true) {
    if (opts.signal?.aborted) throw new Error('Loop restart request was accepted and may still complete')
    const readDb = openWritableForgeDb(opts.dbPath)
    let applied: TuiLoopRestartAppliedState | null
    try {
      applied = createTuiLoopRestartRepo(readDb).getApplied(projectId)
    } finally {
      readDb.close()
    }
    if (applied?.revision === revision) {
      if (applied.status === 'processing') {
        if (Date.now() - startedAt >= timeoutMs) break
        if (!await waitForRestartPoll(pollMs, opts.signal)) throw new Error('Loop restart request was accepted and may still complete')
        continue
      }
      if (applied.error !== null) throw new Error(applied.error)
      return applied
    }
    if (Date.now() - startedAt >= timeoutMs) break
    if (!await waitForRestartPoll(pollMs, opts.signal)) throw new Error('Loop restart request was accepted and may still complete')
  }
  throw new Error(`Timed out waiting for loop restart acknowledgement after ${timeoutMs}ms; the restart request may still complete`)
}
