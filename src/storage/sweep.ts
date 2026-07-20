import type { Database } from 'bun:sqlite'
import { createLoopEventsRepo } from './repos/loop-events-repo'
import { createLoopRunsRepo } from './repos/loop-runs-repo'

/**
 * Sweeps expired completed loops from the database.
 * 
 * Deletes rows from `loops` where:
 * - status != 'running'
 * - completed_at + ttlMs < now()
 * 
 * Cascade deletes propagate to:
 * - loop_large_fields (via FK)
 * - plans with loop_name matching deleted loops (explicit DELETE)
 * 
 * @param db - Database instance
 * @param ttlMs - TTL in milliseconds for completed loops
 * @returns Number of rows deleted from loops table
 */
export function sweepExpiredLoops(db: Database, ttlMs: number): number {
  const cutoff = Date.now() - ttlMs

  const deletePlans = db.prepare(`
    DELETE FROM plans
    WHERE (project_id, loop_name) IN (
      SELECT project_id, loop_name FROM loops
      WHERE status != 'running'
        AND completed_at IS NOT NULL
        AND completed_at < ?
    )
  `)

  const deleteLoops = db.prepare(`
    DELETE FROM loops
    WHERE status != 'running'
      AND completed_at IS NOT NULL
      AND completed_at < ?
  `)

  const run = db.transaction((cutoffMs: unknown) => {
    const cutoff = Number(cutoffMs)
    deletePlans.run(cutoff)
    const loopsResult = deleteLoops.run(cutoff) as unknown as { changes: number }
    return Number(loopsResult.changes)
  }) as (cutoffMs: number) => number

  return run(cutoff)
}

/**
 * Sweeps expired loop metrics rows from `loop_events` and `loop_runs`.
 *
 * Both tables intentionally have no FK to `loops` so their rows survive
 * `sweepExpiredLoops`. This function enforces their own retention window
 * keyed on `created_at`.
 *
 * @param db - Database instance
 * @param ttlMs - TTL in milliseconds; rows whose `created_at` is older than `now() - ttlMs` are deleted
 * @returns Total number of rows deleted across both tables
 */
export function sweepExpiredLoopMetrics(db: Database, ttlMs: number): number {
  const cutoff = Date.now() - ttlMs

  // Delegate each table's retention predicate to its own repo so the WHERE
  // clause lives in one place per table (single source of truth), and run
  // both deletes inside one transaction so partial sweeps cannot occur.
  const loopEventsRepo = createLoopEventsRepo(db)
  const loopRunsRepo = createLoopRunsRepo(db)

  const run = db.transaction((cutoffMs: unknown) => {
    const c = Number(cutoffMs)
    return loopEventsRepo.sweepOlderThan(c) + loopRunsRepo.sweepOlderThan(c)
  }) as (cutoffMs: number) => number

  return run(cutoff)
}
