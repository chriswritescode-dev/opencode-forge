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
