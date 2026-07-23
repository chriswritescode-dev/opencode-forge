import type { Database } from 'bun:sqlite'
import { runImmediateTransaction } from '../immediate-transaction'
import type { NewSessionResolution } from './loop-new-session-outcomes-repo'

/**
 * Authoritative cancellation marker for cross-process `plan.execute.newSession`
 * launches. The TUI's cross-process resolver mints a per-launch
 * {@link LoopNewSessionOutcomeRow.requestNonce} and queues a `promptAsync` on
 * the host session asking its code agent to invoke the `execute-plan` tool
 * with that nonce. If the host stays busy past the resolver deadline, the
 * panel gives up and (before reporting failure) writes a cancellation row
 * here. The server-side `handlePlanNewSession` consults this repo at entry —
 * before creating any session or loop — and refuses to launch when the nonce
 * is already cancelled. This prevents a slow delayed host invocation from
 * silently launching a duplicate loop after the user has retried with a fresh
 * nonce.
 *
 * The row is keyed by `(project_id, request_nonce)` so per-launch nonces
 * never collide. The repo is intentionally decoupled from loop lifecycle so
 * a rolled-back launch cannot orphan its cancellation marker mid-check.
 */
export interface LoopNewSessionCancellationRow {
  projectId: string
  requestNonce: string
  hostSessionId: string
  cancelledAt: number
}

export interface LoopNewSessionCancellationsRepo {
  /** Atomically commit the panel cancellation OR observe that a launch outcome
   *  already won arbitration for this nonce. Runs inside a `BEGIN IMMEDIATE`
   *  transaction so a concurrent `recordExclusive` cannot insert its row
   *  between the cross-table check and this insert. Returns `'cancelled'` if
   *  the cancellation was written (or rewritten for the same nonce), or
   *  `'committed'` if a `loop_new_session_outcomes` row already exists for
   *  this nonce — in which case the cancellation is NOT written and the
   *  caller should treat the launch as having succeeded (re-read the outcome
   *  rather than reporting terminal failure). Replays for the same nonce
   *  commit idempotently (the prior cancellation row wins over a fresh
   *  outcome, so a panel retry that races the host still resolves correctly). */
  cancelExclusive(row: Omit<LoopNewSessionCancellationRow, 'cancelledAt'>): NewSessionResolution
  /** The lookup the server-side handler consults at entry: true iff this
   *  nonce was marked cancelled. */
  isCancelled(projectId: string, requestNonce: string): boolean
}

interface LoopNewSessionCancellationRowRaw {
  project_id: string
  request_nonce: string
  host_session_id: string
  cancelled_at: number
}

export function createLoopNewSessionCancellationsRepo(db: Database): LoopNewSessionCancellationsRepo {
  const stmtInsert = db.prepare(`
    INSERT INTO loop_new_session_cancellations
      (project_id, request_nonce, host_session_id, cancelled_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, request_nonce) DO UPDATE SET
      host_session_id = excluded.host_session_id,
      cancelled_at = excluded.cancelled_at
  `)

  const stmtFind = db.prepare(`
    SELECT project_id, request_nonce, host_session_id, cancelled_at
    FROM loop_new_session_cancellations
    WHERE project_id = ? AND request_nonce = ?
  `)

  const stmtCheckOutcome = db.prepare(`
    SELECT 1 FROM loop_new_session_outcomes
    WHERE project_id = ? AND request_nonce = ?
  `)

  return {
    cancelExclusive(row) {
      // `runImmediateTransaction` issues `BEGIN IMMEDIATE` so the cross-table
      // outcome check and the cancellation insert run under a single reserved
      // write lock — a concurrent `recordExclusive` cannot slip its row in
      // between the check and the insert.
      return runImmediateTransaction(db, (): NewSessionResolution => {
        const committed = stmtCheckOutcome.get(row.projectId, row.requestNonce)
        if (committed) return 'committed'
        stmtInsert.run(row.projectId, row.requestNonce, row.hostSessionId, Date.now())
        return 'cancelled'
      })
    },
    isCancelled(projectId, requestNonce) {
      const row = stmtFind.get(projectId, requestNonce) as LoopNewSessionCancellationRowRaw | undefined
      return row !== undefined
    },
  }
}
