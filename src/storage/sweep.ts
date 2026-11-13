import type { Database } from 'bun:sqlite'
import { statementChanges } from './sqlite-open'

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

  const run = db.transaction(() => {
    deletePlans.run(cutoff)
    return statementChanges(deleteLoops.run(cutoff))
  })

  return run()
}

