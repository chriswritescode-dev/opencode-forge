import type { Database } from 'bun:sqlite'

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
/**
 * Default TTL for cross-process new-session marker rows. They are only needed
 * for a single launch's fencing window, so a week is generously past any
 * resolver deadline.
 */
export const DEFAULT_NEW_SESSION_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000

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
 * Sweeps expired cross-process new-session marker rows: launch outcomes,
 * cancellations, and staged plan requests. Each row is only needed for a
 * single launch's fencing window, but nothing else ever deletes them — without
 * this sweep the tables grow one row per launch forever.
 *
 * @param db - Database instance
 * @param ttlMs - TTL in milliseconds for marker rows
 */
export function sweepExpiredNewSessionMarkers(db: Database, ttlMs: number): void {
  const cutoff = Date.now() - ttlMs

  const deleteOutcomes = db.prepare('DELETE FROM loop_new_session_outcomes WHERE created_at < ?')
  const deleteCancellations = db.prepare('DELETE FROM loop_new_session_cancellations WHERE cancelled_at < ?')
  const deleteRequests = db.prepare('DELETE FROM loop_new_session_requests WHERE created_at < ?')

  const run = db.transaction((cutoffMs: unknown) => {
    const cutoff = Number(cutoffMs)
    deleteOutcomes.run(cutoff)
    deleteCancellations.run(cutoff)
    deleteRequests.run(cutoff)
  }) as (cutoffMs: number) => void

  run(cutoff)
}
