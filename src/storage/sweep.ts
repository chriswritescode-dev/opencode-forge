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

/**
 * Sweeps expired terminal goals and stale drafts from the database.
 *
 * Deletes rows from `goals` where:
 * - status is 'completed' or 'cancelled' and completed_at + ttlMs < now()
 * - status is 'draft' and updated_at + ttlMs < now()
 *
 * Running and paused goals are never deleted. `goal_chunks` rows are removed in
 * the same transaction; when the connection has foreign keys ON the delete also
 * cascades from `goals`.
 *
 * @param db - Database instance
 * @param ttlMs - TTL in milliseconds for terminal goals and stale drafts
 * @returns Number of rows deleted from the goals table
 */
export function sweepExpiredGoals(db: Database, ttlMs: number): number {
  const cutoff = Date.now() - ttlMs
  const foreignKeysOn =
    (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | null)?.foreign_keys === 1

  const deleteChunks = db.prepare(`
    DELETE FROM goal_chunks
    WHERE (project_id, goal_id) IN (
      SELECT project_id, goal_id FROM goals
      WHERE (status IN ('completed', 'cancelled') AND completed_at IS NOT NULL AND completed_at < ?)
         OR (status = 'draft' AND updated_at < ?)
    )
  `)

  const deleteGoals = db.prepare(`
    DELETE FROM goals
    WHERE (status IN ('completed', 'cancelled') AND completed_at IS NOT NULL AND completed_at < ?)
       OR (status = 'draft' AND updated_at < ?)
  `)

  const run = db.transaction((cutoffMs: unknown) => {
    const cutoff = Number(cutoffMs)
    if (!foreignKeysOn) deleteChunks.run(cutoff, cutoff)
    const goalsResult = deleteGoals.run(cutoff, cutoff) as unknown as { changes: number }
    return Number(goalsResult.changes)
  }) as (cutoffMs: number) => number

  return run(cutoff)
}
