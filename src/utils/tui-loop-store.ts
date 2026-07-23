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
import { createLoopNewSessionOutcomesRepo, type LoopNewSessionOutcomeRow } from '../storage/repos/loop-new-session-outcomes-repo'
import { createLoopNewSessionCancellationsRepo, type LoopNewSessionCancellationsRepo } from '../storage/repos/loop-new-session-cancellations-repo'
import type { NewSessionResolution } from '../storage/repos/loop-new-session-outcomes-repo'
import type { LoopInfo } from './tui-models'

/**
 * Outcome of an exclusive panel cancellation attempt. The resolver must NOT
 * report terminal failure unless this resolves to `'cancelled'` — only then
 * has the cancellation marker actually been committed and the delayed
 * host invocation will be refused at handler entry. `'committed'` means the
 * server-side launch outcome already won arbitration (the host invoked the
 * tool just before the deadline); the resolver should re-read the outcome and
 * report the launch as successful rather than abandoned. `'unavailable'`
 * (no shared DB file / closed deployment) and `'write-failed'` (DB open or
 * transaction threw) leave the launch's verdict unconfirmed, so the panel
 * surfaces an explicit uncertain-failure message instead of a plain timeout.
 */
export type CrossProcessCancellationResult =
  | { kind: 'cancelled' }
  | { kind: 'committed' }
  | { kind: 'unavailable' }
  | { kind: 'write-failed'; error: unknown }

/**
 * Resolves the absolute path of the shared Forge SQLite database the server
 * plugin writes to. Honors an explicit override (threaded in by the TUI plugin
 * from {@link PluginConfig.dataDir} via {@link connectForgeProject}); when no
 * override is supplied, falls back to the default Forge data directory.
 * Cross-process polling reads the SAME database the server records outcomes
 * and cancellations into, so a deployment that configures a non-default
 * `dataDir` still resolves launches correctly rather than silently timing out
 * against the default path.
 */
function getDbPath(override?: string): string {
  const dir = override && override.trim().length > 0 ? override : resolveDataDir()
  return join(dir, 'forge.db')
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
  const dbPath = dbPathOverride || getDbPath(undefined)
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

/**
 * Reads the single authoritative `loop_new_session_outcomes` row keyed by this
 * launch's `requestNonce`, from the same shared Forge SQLite store the server
 * plugin writes. The cross-process new-session resolver polls this row —
 * written by `handlePlanNewSession` ONLY after the launch committed (audited:
 * `attachLoopToSession` returned ok; one-shot: session.create + prompt
 * succeeded) — instead of the provisional loop row attach writes before the
 * prompt is sent, so a slow prompt failure cannot produce a false success.
 * Correlating by the per-launch nonce (rather than the predicted session
 * title) fences out an unrelated concurrent same-title session created while
 * polling. Returns `null` when the database or row is unavailable so
 * deployments without shared storage degrade to an explicit resolver timeout
 * rather than throwing.
 */
export function fetchNewSessionOutcomeByNonce(projectId: string, requestNonce: string, dbPathOverride?: string): LoopNewSessionOutcomeRow | null {
  if (!projectId || !requestNonce) return null
  const dbPath = dbPathOverride || getDbPath(undefined)
  if (!existsSync(dbPath)) return null
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    db.run('PRAGMA busy_timeout=5000')
    return createLoopNewSessionOutcomesRepo(db).findByRequestNonce(projectId, requestNonce)
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Writes the authoritative cancellation marker a cross-process new-session
 * launch mints when its resolver times out. `handlePlanNewSession` consults
 * the same shared table at entry and refuses to launch for an already-
 * cancelled nonce, so a delayed host invocation cannot create a duplicate
 * session/loop after the panel has reported failure and the user retried with
 * a fresh nonce.
 *
 * Returns a {@link CrossProcessCancellationResult} instead of swallowing the
 * outcome silently: the caller must not report terminal failure unless the
 * result is `'cancelled'`. When an outcome row has already won arbitration
 * (`'committed'`), the resolver re-reads the outcome and reports the launch
 * as successful. When the shared store is unavailable or the write failed
 * (`'unavailable'` / `'write-failed'`), the panel surfaces an explicit
 * uncertain-failure message — never a clean "launch failed, retry succeeded"
 * story that would mask a real race.
 */
export function cancelNewSessionRequestExclusive(
  projectId: string,
  requestNonce: string,
  hostSessionId: string,
  dbPathOverride?: string,
): CrossProcessCancellationResult {
  if (!projectId || !requestNonce) return { kind: 'unavailable' }
  const dbPath = dbPathOverride || getDbPath(undefined)
  if (!existsSync(dbPath)) return { kind: 'unavailable' }
  let db: Database | null = null
  try {
    db = new Database(dbPath)
    db.run('PRAGMA busy_timeout=5000')
    const repo: LoopNewSessionCancellationsRepo = createLoopNewSessionCancellationsRepo(db)
    const resolution: NewSessionResolution = repo.cancelExclusive({ projectId, requestNonce, hostSessionId })
    return resolution === 'cancelled' ? { kind: 'cancelled' } : { kind: 'committed' }
  } catch (err) {
    return { kind: 'write-failed', error: err }
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Non-arbitrated diagnostic writer: unconditionally inserts a cancellation
 * row for the nonce (idempotent on the primary key). Production resolver
 * paths use {@link cancelNewSessionRequestExclusive} so they can distinguish a
 * win from a lost race; tests and diagnostic seeding use this simpler form
 * because they intentionally bypass arbitration.
 */
export function cancelNewSessionRequest(
  projectId: string,
  requestNonce: string,
  hostSessionId: string,
  dbPathOverride?: string,
): void {
  if (!projectId || !requestNonce) return
  const dbPath = dbPathOverride || getDbPath(undefined)
  if (!existsSync(dbPath)) return
  let db: Database | null = null
  try {
    db = new Database(dbPath)
    db.run('PRAGMA busy_timeout=5000')
    createLoopNewSessionCancellationsRepo(db).cancel({ projectId, requestNonce, hostSessionId })
  } catch {
    // Best-effort: callers route through cancelNewSessionRequestExclusive when
    // the result matters; this diagnostic path never throws.
  } finally {
    try { db?.close() } catch {}
  }
}
