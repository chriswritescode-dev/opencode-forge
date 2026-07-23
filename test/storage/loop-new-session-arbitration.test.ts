import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { rmSync } from 'fs'
import Database from 'better-sqlite3'

import { createLoopNewSessionOutcomesRepo } from '../../src/storage/repos/loop-new-session-outcomes-repo'
import { createLoopNewSessionCancellationsRepo } from '../../src/storage/repos/loop-new-session-cancellations-repo'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { cancelNewSessionRequestExclusive } from '../../src/utils/tui-loop-store'

const PROJECT_ID = 'proj-arbitration'

function freshDb(): { db: Database; dbPath: string } {
  const dbPath = join(tmpdir(), `forge-arbitration-${randomUUID()}.db`)
  // better-sqlite3 creates the file at open time; no mkdir needed (the path
  // is a file, not a directory).
  const db = new Database(dbPath)
  setupLoopsTestDb(db)
  return { db, dbPath }
}

describe('per-nonce atomic arbitration between outcome and cancellation', () => {
  /**
   * Auditor issue #1: the cancellation marker blocks invocations arriving
   * AFTER timeout, but a handler that already passed its entry check could
   * still commit an outcome AFTER the panel wrote the cancellation, leaving a
   * duplicate loop paired with the panel's terminal failure. `recordExclusive`
   * and `cancelExclusive` perform a BEGIN IMMEDIATE cross-table check so
   * exactly one of cancellation or launch outcome can commit for a nonce.
   */
  let db: Database
  let dbPath: string

  beforeEach(() => {
    const fresh = freshDb()
    db = fresh.db
    dbPath = fresh.dbPath
  })

  afterEach(() => {
    db.close()
    rmSync(dbPath, { force: true })
  })

  test('a cancellation written first wins — recordExclusive returns "cancelled" and writes no outcome', () => {
    const cancellations = createLoopNewSessionCancellationsRepo(db)
    const outcomes = createLoopNewSessionOutcomesRepo(db)

    cancellations.cancelExclusive({ projectId: PROJECT_ID, requestNonce: 'race-1', hostSessionId: 'host-A' })

    const resolution = outcomes.recordExclusive({
      projectId: PROJECT_ID,
      requestNonce: 'race-1',
      hostSessionId: 'host-A',
      outcomeSessionId: 'session-A',
      loopName: 'loop-A',
      kind: 'audited',
    })

    expect(resolution).toBe('cancelled')
    expect(outcomes.findByRequestNonce(PROJECT_ID, 'race-1')).toBeNull()
    expect(cancellations.isCancelled(PROJECT_ID, 'race-1')).toBe(true)
  })

  test('an outcome written first wins — cancelExclusive returns "committed" and writes no cancellation', () => {
    const cancellations = createLoopNewSessionCancellationsRepo(db)
    const outcomes = createLoopNewSessionOutcomesRepo(db)

    outcomes.recordExclusive({
      projectId: PROJECT_ID,
      requestNonce: 'race-2',
      hostSessionId: 'host-A',
      outcomeSessionId: 'session-B',
      loopName: 'loop-B',
      kind: 'one-shot',
    })

    const resolution = cancellations.cancelExclusive({ projectId: PROJECT_ID, requestNonce: 'race-2', hostSessionId: 'host-A' })

    expect(resolution).toBe('committed')
    expect(cancellations.isCancelled(PROJECT_ID, 'race-2')).toBe(false)
    expect(outcomes.findByRequestNonce(PROJECT_ID, 'race-2')?.outcomeSessionId).toBe('session-B')
  })

  test('a first committed outcome is authoritative — a same-nonce recordExclusive replay returns "superseded" and writes nothing', () => {
    /** Auditor issue: when two concurrent same-nonce dispatches both pass the
     *  pre-entry replay guard before either commits, the FIRST committed
     *  outcome row must win. `recordExclusive` used to `ON CONFLICT DO
     *  UPDATE`, so the second writer silently overwrote the prior row while
     *  its OWN provisioned session/loop kept running — two live artifacts, one
     *  recorded session, both callers reporting success against the second's
     *  id. The exclusive insert is now upsert-free with a prior-row existence
     *  check, so the second writer observes `'superseded'` and the caller rolls
     *  back its own resources while preserving the authoritative outcome. A
     *  later panel cancellation for the same nonce still loses to the
     *  committed outcome (idempotent arbitration). */
    const outcomes = createLoopNewSessionOutcomesRepo(db)
    const cancellations = createLoopNewSessionCancellationsRepo(db)

    const first = outcomes.recordExclusive({
      projectId: PROJECT_ID,
      requestNonce: 'race-3',
      hostSessionId: 'host-A',
      outcomeSessionId: 'session-first',
      loopName: 'loop-3',
      kind: 'audited',
    })
    const cancellation = cancellations.cancelExclusive({ projectId: PROJECT_ID, requestNonce: 'race-3', hostSessionId: 'host-A' })
    const second = outcomes.recordExclusive({
      projectId: PROJECT_ID,
      requestNonce: 'race-3',
      hostSessionId: 'host-A',
      outcomeSessionId: 'session-second',
      loopName: 'loop-3',
      kind: 'audited',
    })

    expect(first).toBe('committed')
    // A panel cancellation arriving AFTER the outcome commits loses (the
    // outcome row is authoritative) — the resolver must re-read the outcome
    // and report success, never phantom-failure the user.
    expect(cancellation).toBe('committed')
    // The retry-with-same-nonce writer observes the prior committed outcome
    // and rolls back. The first outcome row is preserved verbatim.
    expect(second).toBe('superseded')
    expect(cancellations.isCancelled(PROJECT_ID, 'race-3')).toBe(false)
    const persisted = outcomes.findByRequestNonce(PROJECT_ID, 'race-3')
    expect(persisted?.outcomeSessionId).toBe('session-first')
    expect(persisted?.loopName).toBe('loop-3')
  })

  test('re-cancelling the same cancelled nonce is idempotent — outraces a later outcome attempt', () => {
    /** Symmetric to the previous case: an earlier cancellation wins over a
     *  fresh outcome write for the same nonce, so a delayed host invocation
     *  arriving after the panel already abandoned the launch is refused. */
    const outcomes = createLoopNewSessionOutcomesRepo(db)
    const cancellations = createLoopNewSessionCancellationsRepo(db)

    const first = cancellations.cancelExclusive({ projectId: PROJECT_ID, requestNonce: 'race-4', hostSessionId: 'host-A' })
    const outcome = outcomes.recordExclusive({
      projectId: PROJECT_ID,
      requestNonce: 'race-4',
      hostSessionId: 'host-A',
      outcomeSessionId: 'session-D',
      loopName: null,
      kind: 'one-shot',
    })
    const second = cancellations.cancelExclusive({ projectId: PROJECT_ID, requestNonce: 'race-4', hostSessionId: 'host-A' })

    expect(first).toBe('cancelled')
    expect(outcome).toBe('cancelled')
    expect(second).toBe('cancelled')
    expect(outcomes.findByRequestNonce(PROJECT_ID, 'race-4')).toBeNull()
    expect(cancellations.isCancelled(PROJECT_ID, 'race-4')).toBe(true)
  })

  test('two nonces independently arbitrate without cross-talk', () => {
    const outcomes = createLoopNewSessionOutcomesRepo(db)
    const cancellations = createLoopNewSessionCancellationsRepo(db)

    outcomes.recordExclusive({
      projectId: PROJECT_ID,
      requestNonce: 'nonce-A',
      hostSessionId: 'host-A',
      outcomeSessionId: 'session-A',
      loopName: 'loop-A',
      kind: 'audited',
    })
    cancellations.cancelExclusive({ projectId: PROJECT_ID, requestNonce: 'nonce-B', hostSessionId: 'host-B' })

    expect(cancellations.isCancelled(PROJECT_ID, 'nonce-A')).toBe(false)
    expect(cancellations.isCancelled(PROJECT_ID, 'nonce-B')).toBe(true)
    expect(outcomes.findByRequestNonce(PROJECT_ID, 'nonce-A')?.outcomeSessionId).toBe('session-A')
    expect(outcomes.findByRequestNonce(PROJECT_ID, 'nonce-B')).toBeNull()
  })

  test('cancelNewSessionRequestExclusive propagates the arbitration result — committed race resolves to success', () => {
    /** The shared-store helper the panel's markCancelled closure calls returns
     *  a discriminated CrossProcessCancellationResult so the resolver knows
     *  whether it won the cancellation, lost to a committed outcome, or could
     *  not confirm. Seeding an outcome first means the helper reports
     *  `'committed'`, never silently writing a stray cancellation. */
    const outcomes = createLoopNewSessionOutcomesRepo(db)
    outcomes.recordExclusive({
      projectId: PROJECT_ID,
      requestNonce: 'race-5',
      hostSessionId: 'host-A',
      outcomeSessionId: 'session-E',
      loopName: 'loop-E',
      kind: 'audited',
    })
    db.close()

    const result = cancelNewSessionRequestExclusive(PROJECT_ID, 'race-5', 'host-A', dbPath)
    expect(result).toEqual({ kind: 'committed' })

    // Confirm no cancellation row was written alongside the existing outcome.
    const reopen = new Database(dbPath)
    expect(createLoopNewSessionCancellationsRepo(reopen).isCancelled(PROJECT_ID, 'race-5')).toBe(false)
    reopen.close()
  })

  test('cancelNewSessionRequestExclusive resolves to cancelled when the nonce is uncontested', () => {
    db.close()
    const result = cancelNewSessionRequestExclusive(PROJECT_ID, 'race-6', 'host-A', dbPath)
    expect(result).toEqual({ kind: 'cancelled' })

    const reopen = new Database(dbPath)
    expect(createLoopNewSessionCancellationsRepo(reopen).isCancelled(PROJECT_ID, 'race-6')).toBe(true)
    expect(createLoopNewSessionOutcomesRepo(reopen).findByRequestNonce(PROJECT_ID, 'race-6')).toBeNull()
    reopen.close()
  })

  test('cancelNewSessionRequestExclusive reports unavailable when the shared DB file does not exist', () => {
    db.close()
    rmSync(dbPath, { force: true })
    const result = cancelNewSessionRequestExclusive(PROJECT_ID, 'race-missing', 'host-A', dbPath)
    expect(result).toEqual({ kind: 'unavailable' })
  })
})
