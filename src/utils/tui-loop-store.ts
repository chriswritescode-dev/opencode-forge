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
import { createLoopNewSessionOutcomesRepo, type LoopNewSessionOutcomeRow, type LoopNewSessionOutcomesRepo } from '../storage/repos/loop-new-session-outcomes-repo'
import { createLoopNewSessionCancellationsRepo } from '../storage/repos/loop-new-session-cancellations-repo'
import { createLoopNewSessionRequestsRepo } from '../storage/repos/loop-new-session-requests-repo'
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
 * plugin writes to, under the default Forge data directory. Callers on a
 * deployment with a non-default {@link PluginConfig.dataDir} bypass this by
 * passing a full `dbPathOverride` (threaded in by the TUI plugin via
 * {@link connectForgeProject}), so cross-process polling reads the SAME
 * database the server records outcomes and cancellations into rather than
 * silently timing out against the default path.
 */
function getDbPath(): string {
  return join(resolveDataDir(), 'forge.db')
}

function openForgeDb(dbPath: string, options: { readonly?: boolean }): Database {
  const db = new Database(dbPath, options.readonly ? { readonly: true } : undefined)
  db.run('PRAGMA busy_timeout=5000')
  return db
}

type ForgeDbResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'missing' | 'error'; error?: unknown }

/**
 * Opens the shared Forge database for a single scoped operation: existence
 * guard, busy-timeout pragma, `fn`, and a guaranteed close. Returns a
 * discriminated result instead of throwing so each accessor can map a missing
 * database and a failed operation to its own degraded value.
 */
function withForgeDb<T>(dbPath: string, options: { readonly?: boolean }, fn: (db: Database) => T): ForgeDbResult<T> {
  if (!existsSync(dbPath)) return { ok: false, reason: 'missing' }
  let db: Database | null = null
  try {
    db = openForgeDb(dbPath, options)
    return { ok: true, value: fn(db) }
  } catch (err) {
    return { ok: false, reason: 'error', error: err }
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
  const result = withForgeDb(dbPathOverride || getDbPath(), { readonly: true }, (db) => {
    const loopsRepo = createLoopsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)

    const rows = loopsRepo.listAll(projectId)
    return rows.map((row) => {
      const plans = sectionPlansRepo.list(projectId, row.loopName)
      return rowToLoopInfo(row, plans.length > 0 ? plans : undefined)
    })
  })
  return result.ok ? result.value : []
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
  const result = withForgeDb(dbPathOverride || getDbPath(), { readonly: true }, (db) =>
    createLoopNewSessionOutcomesRepo(db).findByRequestNonce(projectId, requestNonce))
  return result.ok ? result.value : null
}

/**
 * Poll-duration variant of {@link fetchNewSessionOutcomeByNonce} for the
 * cross-process resolver: opens ONE readonly connection lazily (retrying while
 * the database file does not exist yet) and reuses its prepared nonce lookup
 * across ticks, instead of reopening the database and re-preparing every repo
 * statement on each poll of the synchronous TUI event loop. A transient read
 * failure closes the connection so the next tick reopens cleanly; `close` is
 * idempotent and must be called when the resolver settles.
 */
export interface NewSessionOutcomeReader {
  fetch(projectId: string, requestNonce: string): LoopNewSessionOutcomeRow | null
  close(): void
}

export function openNewSessionOutcomeReader(dbPathOverride?: string): NewSessionOutcomeReader {
  const dbPath = dbPathOverride || getDbPath()
  let db: Database | null = null
  let findByRequestNonce: LoopNewSessionOutcomesRepo['findByRequestNonce'] | null = null
  const dispose = (): void => {
    try { db?.close() } catch {}
    db = null
    findByRequestNonce = null
  }
  return {
    fetch(projectId, requestNonce) {
      if (!projectId || !requestNonce) return null
      try {
        if (!findByRequestNonce) {
          if (!existsSync(dbPath)) return null
          db = openForgeDb(dbPath, { readonly: true })
          findByRequestNonce = createLoopNewSessionOutcomesRepo(db).findByRequestNonce
        }
        return findByRequestNonce(projectId, requestNonce)
      } catch {
        dispose()
        return null
      }
    },
    close: dispose,
  }
}

/**
 * Stages the full plan text for a cross-process new-session launch into the
 * shared Forge database, keyed by (projectId, requestNonce) — the same nonce
 * the outcome/cancellation stores correlate on. The TUI writes this row
 * BEFORE dispatching the host-agent instruction so the host LLM passes only
 * the nonce (never re-emitting the plan verbatim) and the server-side
 * `execute-plan` tool resolves the plan back by nonce. Idempotent: re-staging
 * the same nonce overwrites the prior text. Returns `false` when the shared
 * database is missing or the write fails, so the caller can refuse dispatch
 * instead of queuing an instruction whose plan the server could never resolve.
 */
export function stageNewSessionPlan(projectId: string, requestNonce: string, planText: string, dbPathOverride?: string): boolean {
  if (!projectId || !requestNonce) return false
  const result = withForgeDb(dbPathOverride || getDbPath(), {}, (db) =>
    createLoopNewSessionRequestsRepo(db).stagePlan({ projectId, requestNonce, planText }))
  return result.ok
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
  const result = withForgeDb(dbPathOverride || getDbPath(), {}, (db) =>
    createLoopNewSessionCancellationsRepo(db).cancelExclusive({ projectId, requestNonce, hostSessionId }))
  if (!result.ok) {
    return result.reason === 'missing' ? { kind: 'unavailable' } : { kind: 'write-failed', error: result.error }
  }
  return result.value === 'cancelled' ? { kind: 'cancelled' } : { kind: 'committed' }
}
