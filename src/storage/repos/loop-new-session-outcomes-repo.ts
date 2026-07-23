import type { Database } from 'bun:sqlite'

export type NewSessionOutcomeKind = 'audited' | 'one-shot'

export interface LoopNewSessionOutcomeRow {
  projectId: string
  /** Per-launch correlation nonce minted by the TUI caller and threaded
   *  through the execute-plan tool / bridge into {@link ForgeExecutionRequestContext.requestId}.
   *  The cross-process resolver's authoritative lookup key — every launch
   *  gets a fresh nonce, so concurrent launches never collide. */
  requestNonce: string
  hostSessionId: string
  /** The session the handler created (loop executor session for audited,
   *  plain one-shot session for the fallback). */
  outcomeSessionId: string
  /** Loop name for audited launches; null for one-shot fallbacks. */
  loopName: string | null
  kind: NewSessionOutcomeKind
  createdAt: number
}

/** The winner of atomic per-nonce arbitration between a launch outcome and a
 *  panel cancellation. Exactly one of `committed`, `cancelled`, or
 *  `superseded` can commit for a given `(project_id, request_nonce)` pair.
 *
 *  - `'committed'`: the outcome row was written by this call (or replayed
 *    idempotently by the same launch).
 *  - `'cancelled'`: a `loop_new_session_cancellations` row already won
 *    arbitration for this nonce — the outcome is NOT written and the caller
 *    must roll the launched session/loop back as abandoned.
 *  - `'superseded'`: another launch already committed the outcome row for this
 *    same nonce (a concurrent same-nonce race where both invocations passed
 *    the pre-entry replay guard before either committed). The first committed
 *    outcome is authoritative; this call writes nothing and the caller must
 *    roll back its OWN newly provisioned session/loop while preserving the
 *    prior outcome (re-read it and report success against it, mirroring the
 *    pre-entry replay path). */
export type NewSessionResolution = 'committed' | 'cancelled' | 'superseded'

export interface LoopNewSessionOutcomesRepo {
  /** Insert an authoritative post-launch outcome marker. Idempotent on the
   *  (project_id, request_nonce) primary key — re-recording for the same
   *  launch simply overwrites the prior `created_at`. Throws when the write
   *  fails so the caller can roll the launch back consistently rather than
   *  silently leaving a running loop paired with a missing TUI signal.
   *
   *  This method does NOT consult the cancellations table. Production launch
   *  paths should prefer {@link recordExclusive}, which refuses to commit when
   *  a cancellation row has already won arbitration for this nonce. `record`
   *  remains for diagnostic seeding and tests that bypass arbitration. */
  record(row: Omit<LoopNewSessionOutcomeRow, 'createdAt'>): void
  /** Atomically commit the launch outcome OR observe that another row already
   *  won arbitration for this nonce. Runs inside a `BEGIN IMMEDIATE`
   *  transaction so a concurrent `cancelExclusive` (or a second
   *  `recordExclusive` for the same nonce) cannot insert its row between the
   *  cross-table check and this insert. Returns:
   *
   *  - `'committed'` if the outcome row was written by THIS call.
   *  - `'cancelled'` if a `loop_new_session_cancellations` row already exists
   *    for this nonce — the outcome is NOT written and the caller must roll
   *    the launched session/loop back as abandoned.
   *  - `'superseded'` if a `loop_new_session_outcomes` row already exists for
   *    this nonce (a concurrent same-nonce launch committed first). The first
   *    committed outcome is authoritative — this call writes nothing and the
   *    caller must roll back its OWN newly provisioned session/loop, re-read
   *    the existing outcome, and report success against it (so two concurrent
   *    same-nonce dispatches leave exactly one session/loop and return the
   *    same authoritative result).
   *
   *  Replays for the same nonce from the SAME committed launch resolve to
   *  `'committed'` only on the first write; a concurrent second writer will
   *  observe `'superseded'` so its provisioned resources are abandoned. */
  recordExclusive(row: Omit<LoopNewSessionOutcomeRow, 'createdAt'>): NewSessionResolution
  /** The authoritative lookup the cross-process new-session resolver polls:
   *  returns the single outcome row keyed by this launch's nonce, or null. */
  findByRequestNonce(projectId: string, requestNonce: string): LoopNewSessionOutcomeRow | null
  /** Recent outcomes attributed to a host session (newest-first); used for
   *  diagnostics and host-scoped inspection. */
  listByHostSession(hostSessionId: string): LoopNewSessionOutcomeRow[]
  /** Drop a launch's outcome row (e.g. on rollback before retry). */
  deleteByNonce(projectId: string, requestNonce: string): void
}

interface LoopNewSessionOutcomeRowRaw {
  project_id: string
  request_nonce: string
  host_session_id: string
  outcome_session_id: string
  loop_name: string | null
  kind: string
  created_at: number
}

function mapRow(row: LoopNewSessionOutcomeRowRaw): LoopNewSessionOutcomeRow {
  return {
    projectId: row.project_id,
    requestNonce: row.request_nonce,
    hostSessionId: row.host_session_id,
    outcomeSessionId: row.outcome_session_id,
    loopName: row.loop_name,
    kind: row.kind as NewSessionOutcomeKind,
    createdAt: row.created_at,
  }
}

export function createLoopNewSessionOutcomesRepo(db: Database): LoopNewSessionOutcomesRepo {
  // `record` stays idempotent-on-retry (overwrites); `recordExclusive` uses an
  // upsert-free insert plus a prior-row existence check inside the same
  // IMMEDIATE transaction so the FIRST committed outcome wins and a concurrent
  // same-nonce writer observes `'superseded'` and rolls back.
  const stmtInsert = db.prepare(`
    INSERT INTO loop_new_session_outcomes
      (project_id, request_nonce, host_session_id, outcome_session_id, loop_name, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, request_nonce) DO UPDATE SET
      host_session_id = excluded.host_session_id,
      outcome_session_id = excluded.outcome_session_id,
      loop_name = excluded.loop_name,
      kind = excluded.kind,
      created_at = excluded.created_at
  `)

  const stmtInsertIfAbsent = db.prepare(`
    INSERT INTO loop_new_session_outcomes
      (project_id, request_nonce, host_session_id, outcome_session_id, loop_name, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, request_nonce) DO NOTHING
  `)

  const stmtCheckOutcome = db.prepare(`
    SELECT 1 FROM loop_new_session_outcomes
    WHERE project_id = ? AND request_nonce = ?
  `)

  const stmtFindByNonce = db.prepare(`
    SELECT project_id, request_nonce, host_session_id, outcome_session_id, loop_name, kind, created_at
    FROM loop_new_session_outcomes
    WHERE project_id = ? AND request_nonce = ?
  `)

  const stmtListByHost = db.prepare(`
    SELECT project_id, request_nonce, host_session_id, outcome_session_id, loop_name, kind, created_at
    FROM loop_new_session_outcomes
    WHERE host_session_id = ?
    ORDER BY created_at DESC
  `)

  const stmtDeleteByNonce = db.prepare(`
    DELETE FROM loop_new_session_outcomes
    WHERE project_id = ? AND request_nonce = ?
  `)

  const stmtCheckCancellation = db.prepare(`
    SELECT 1 FROM loop_new_session_cancellations
    WHERE project_id = ? AND request_nonce = ?
  `)

  // Mutable holders so `recordExclusive` can stage args before invoking the
  // precompiled transaction closure (the closure cannot capture call-scoped
  // args directly because `db.transaction(fn)` returns a reusable function).
  let projectIdOf = ''
  let requestNonceOf = ''
  let hostSessionIdOf = ''
  let outcomeSessionIdOf = ''
  let loopNameOf: string | null = null
  let kindOf: NewSessionOutcomeKind = 'audited'

  // `db.transaction(fn).immediate()` issues `BEGIN IMMEDIATE` so the cross-table
  // cancellation check and the outcome insert run under a single reserved write
  // lock — a concurrent `cancelExclusive` cannot slip its row in between the
  // check and the insert. The bun-types call signature hides the `.immediate`
  // property, so mirror the cast pattern used by `section-plans-repo.ts`.
  const runExclusive = db.transaction((): NewSessionResolution => {
    const cancelled = stmtCheckCancellation.get(projectIdOf, requestNonceOf)
    if (cancelled) return 'cancelled'
    // A prior committed outcome for this nonce wins; the caller rolls back its
    // own provisioned resources and re-reports the existing outcome.
    const existing = stmtCheckOutcome.get(projectIdOf, requestNonceOf)
    if (existing) return 'superseded'
    stmtInsertIfAbsent.run(
      projectIdOf,
      requestNonceOf,
      hostSessionIdOf,
      outcomeSessionIdOf,
      loopNameOf,
      kindOf,
      Date.now(),
    )
    return 'committed'
  }) as unknown as { (): NewSessionResolution; immediate: () => NewSessionResolution }

  return {
    record(row) {
      stmtInsert.run(
        row.projectId,
        row.requestNonce,
        row.hostSessionId,
        row.outcomeSessionId,
        row.loopName ?? null,
        row.kind,
        Date.now(),
      )
    },
    recordExclusive(row) {
      // Captured outside the transaction closure so the broader signature
      // (Omit<...,'createdAt'>) stays free of closure-aliasing surprises.
      projectIdOf = row.projectId
      requestNonceOf = row.requestNonce
      hostSessionIdOf = row.hostSessionId
      outcomeSessionIdOf = row.outcomeSessionId
      loopNameOf = row.loopName ?? null
      kindOf = row.kind
      return runExclusive.immediate()
    },
    findByRequestNonce(projectId, requestNonce) {
      const row = stmtFindByNonce.get(projectId, requestNonce) as LoopNewSessionOutcomeRowRaw | undefined
      return row ? mapRow(row) : null
    },
    listByHostSession(hostSessionId) {
      return (stmtListByHost.all(hostSessionId) as LoopNewSessionOutcomeRowRaw[]).map(mapRow)
    },
    deleteByNonce(projectId, requestNonce) {
      stmtDeleteByNonce.run(projectId, requestNonce)
    },
  }
}
