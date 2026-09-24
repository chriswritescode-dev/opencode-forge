import { migrations } from '../../src/storage/migrations'
import { FORGE_PRAGMAS } from '../../src/storage/database'

type TestDatabase = {
  prepare(sql: string): { run(...params: unknown[]): unknown }
  exec(sql: string): unknown
}

/**
 * Apply all production migrations to a fresh test DB so loops/loop_large_fields/
 * loop_session_usage/plans/review_findings/section_plans/tui_preferences schemas
 * match production. Use this instead of inline CREATE TABLE blocks so future
 * migrations don't silently drift from tests.
 */
export function setupLoopsTestDb(db: TestDatabase): void {
  const migrationDb = db as any
  migrationDb.run ??= (sql: string, ...params: unknown[]) => {
    if (params.length > 0) return db.prepare(sql).run(...params)
    return db.exec(sql)
  }
  for (const pragma of FORGE_PRAGMAS) {
    db.exec(pragma)
  }
  for (const m of migrations) {
    m.apply(migrationDb as Parameters<typeof m.apply>[0])
  }
}
