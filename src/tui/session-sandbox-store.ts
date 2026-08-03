import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { randomUUID } from 'node:crypto'
import { resolveForgeDbPath } from '../storage'
import { createSessionSandboxPreferencesRepo } from '../storage/repos/session-sandbox-preferences-repo'
import type { SessionSandboxAppliedState, SessionSandboxControllerState, SessionSandboxDesiredState } from '../storage/repos/session-sandbox-preferences-repo'

/**
 * Opens the local forge database for a bounded TUI operation. Returns null when
 * the file is missing so an uninitialized instance is never implicitly created
 * as a second, empty database. The server owns the schema (WAL, migrations,
 * integrity recovery); the TUI only applies `busy_timeout` and never runs
 * migrations or bootstrap.
 */
function openForgeDb(dbPathOverride?: string): Database | null {
  const dbPath = dbPathOverride || resolveForgeDbPath()
  if (!existsSync(dbPath)) return null
  // `readwrite` must be set explicitly: bun:sqlite derives its open flags from these options, and
  // `{ create: false }` alone yields neither READONLY nor READWRITE, which SQLite rejects outright.
  // The store also writes desired state, so readonly is not sufficient.
  const db = new Database(dbPath, { readwrite: true, create: false })
  try {
    db.run('PRAGMA busy_timeout=5000')
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

export interface SessionSandboxPreference {
  desired: SessionSandboxDesiredState | null
  applied: SessionSandboxAppliedState | null
  controller?: SessionSandboxControllerState | null
  /**
   * True when the read could not reach an initialized `tui_preferences` table for the project
   * (missing database file, uninitialized table, or unreadable/corrupt file). This lets callers
   * distinguish "no persisted state" from "the local DB is not available yet" so they can retry
   * instead of permanently treating a transient startup failure as OFF.
   */
  unavailable?: boolean
  /**
   * Why the read was unavailable, for logging. Distinguishes a missing database file from an
   * unreadable or uninitialized one so the failure is diagnosable instead of silently opaque.
   */
  unavailableReason?: string
}

/**
 * Returns a blocking reason when the toggle must not write desired state, or
 * null to proceed. When sandboxing is disabled by configuration the server
 * never constructs a reconciler, so a persisted request could never be
 * acknowledged and would linger until it is unexpectedly applied after
 * sandboxing is re-enabled.
 */
export function hostSandboxToggleBlocked(configEnabled: boolean): string | null {
  if (!configEnabled) return 'Host sandbox is disabled by config (sandbox.enabled: false)'
  return null
}

/**
 * Returns the trusted applied state for a preference pair, or null. ON is trusted
 * only when the desired and applied revisions match, both target the same session,
 * desired is enabled, and the applied row carries no error. Stale or mismatched
 * revisions always derive to null so a late or superseded acknowledgement never
 * falsely reports ON.
 */
export function deriveSessionSandboxAcknowledged(
  pref: SessionSandboxPreference,
): SessionSandboxAppliedState | null {
  const { desired, applied } = pref
  if (
    desired &&
    applied &&
    desired.revision === applied.revision &&
    desired.enabled &&
    applied.enabled &&
    desired.sessionId === applied.sessionId &&
    applied.error == null
  ) {
    return applied
  }
  return null
}

/**
 * Returns true when the preference pair has reached a terminal state and no
 * further polling is needed: either no desired state is persisted, or the
 * applied row carries the desired revision (regardless of enabled/error). A
 * pair is pending only while a desired state awaits its matching applied
 * acknowledgement.
 */
export function isSessionSandboxPreferenceSettled(pref: SessionSandboxPreference): boolean {
  const { desired, applied } = pref
  if (!desired) return true
  if (!applied) return false
  return applied.revision === desired.revision
}

export type SessionSandboxDisplayStatus = 'enabled' | 'disabled' | 'loading'

export function deriveSessionSandboxDisplayStatus(
  pref: SessionSandboxPreference | null,
  sessionId?: string,
): SessionSandboxDisplayStatus {
  if (!pref || !sessionId) return 'disabled'
  const controller = pref.controller
  if (
    controller &&
    controller.revision === pref.desired?.revision &&
    controller.sessionId === sessionId
  ) {
    if (controller.phase === 'loading' && pref.desired?.enabled) return 'loading'
    if (controller.phase === 'failed') return 'disabled'
  }
  const acknowledged = deriveSessionSandboxAcknowledged(pref)
  if (acknowledged?.sessionId === sessionId) return 'enabled'
  if (pref.desired?.sessionId === sessionId && !isSessionSandboxPreferenceSettled(pref)) return 'loading'
  return 'disabled'
}

/**
 * Reads the desired and applied sandbox rows for a project from the local forge
 * database. Falls back to both null when the database or table is unavailable.
 */
export function readSessionSandboxPreference(projectId: string, dbPath?: string): SessionSandboxPreference {
  let db: Database | null = null
  try {
    db = openForgeDb(dbPath)
    if (!db) {
      return { desired: null, applied: null, unavailable: true, unavailableReason: 'database file not found' }
    }
    const repo = createSessionSandboxPreferencesRepo(db)
    return { ...repo.getPair(projectId), unavailable: false }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { desired: null, applied: null, unavailable: true, unavailableReason: reason }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Persists a desired sandbox state through the repository's single atomic
 * upsert. Propagates write errors (missing table, locked, etc.) to the caller.
 */
export function writeSessionSandboxDesired(
  projectId: string,
  dbPath: string | undefined,
  state: SessionSandboxDesiredState,
): void {
  let db: Database | null = null
  try {
    db = openForgeDb(dbPath)
    if (!db) throw new Error('Forge database unavailable for local sandbox control')
    createSessionSandboxPreferencesRepo(db).setDesired(projectId, state)
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close errors
    }
  }
}

export interface RequestSessionSandboxStateOptions {
  projectId: string
  dbPath?: string
  sessionId: string
  enabled: boolean
  timeoutMs: number
  pollMs: number
  signal?: AbortSignal
}

function createRevision(): string {
  return randomUUID()
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Sandbox state request cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Sandbox state request cancelled'))
    }
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * Writes a fresh desired revision synchronously and returns it. Callers that
 * need to re-derive acknowledged state immediately (before the matching applied
 * acknowledgement arrives) use this to split request creation from awaiting it.
 */
export function beginSessionSandboxStateRequest(
  projectId: string,
  dbPath: string | undefined,
  opts: { sessionId: string; enabled: boolean },
): string {
  const revision = createRevision()
  const desired: SessionSandboxDesiredState = {
    version: 1,
    revision,
    enabled: opts.enabled,
    sessionId: opts.sessionId,
    requestedAt: Date.now(),
  }
  writeSessionSandboxDesired(projectId, dbPath, desired)
  return revision
}

/**
 * Polls the applied row until the matching revision arrives. Returns the applied
 * state. Throws on a matching `error`, on timeout, or when cancelled via
 * `signal`. Stale applied revisions are ignored.
 */
export async function awaitSessionSandboxState(
  projectId: string,
  dbPath: string | undefined,
  revision: string,
  opts: { timeoutMs: number; pollMs: number; signal?: AbortSignal },
): Promise<SessionSandboxAppliedState> {
  const start = Date.now()
  while (true) {
    // Check cancellation before each read so an already-aborted waiter never returns an existing
    // acknowledgement; cancellation is only meaningful at read boundaries, not only while sleeping.
    if (opts.signal?.aborted) throw new Error('Sandbox state request cancelled')
    const { applied } = readSessionSandboxPreference(projectId, dbPath)
    if (applied && applied.revision === revision) {
      // A non-null error — including an empty string — rejects the request.
      if (applied.error !== null) throw new Error(applied.error)
      return applied
    }
    // Read before declaring timeout so any matching acknowledgement present by the deadline
    // (including one that arrives during the final sleep) resolves successfully.
    const elapsed = Date.now() - start
    if (elapsed >= opts.timeoutMs) break
    await abortableSleep(Math.min(opts.pollMs, opts.timeoutMs - elapsed), opts.signal)
  }
  throw new Error(`Timed out waiting for sandbox acknowledgement after ${opts.timeoutMs}ms`)
}

/**
 * Writes a fresh desired revision and polls the applied row until the matching
 * revision arrives. Returns the applied state. Throws on a matching `error`, on
 * timeout, or when cancelled via `signal`. Stale applied revisions are ignored.
 */
export async function requestSessionSandboxState(
  opts: RequestSessionSandboxStateOptions,
): Promise<SessionSandboxAppliedState> {
  // Check cancellation before writing a new desired revision so an already-aborted request never
  // persists desired state the server may still apply. Otherwise a pre-cancelled request would
  // reject as cancelled yet leave an orphaned desired row.
  if (opts.signal?.aborted) throw new Error('Sandbox state request cancelled')
  const revision = beginSessionSandboxStateRequest(opts.projectId, opts.dbPath, {
    sessionId: opts.sessionId,
    enabled: opts.enabled,
  })
  return awaitSessionSandboxState(opts.projectId, opts.dbPath, revision, {
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    signal: opts.signal,
  })
}
