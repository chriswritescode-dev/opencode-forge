import { migrations } from '../../src/storage/migrations'

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
  for (const m of migrations) {
    m.apply(migrationDb as Parameters<typeof m.apply>[0])
  }
}
