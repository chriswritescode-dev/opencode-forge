import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { migrations } from '../../src/storage/migrations'
import { FORGE_PRAGMAS, openForgeDatabase } from '../../src/storage/database'

type TestDatabase = {
  prepare(sql: string): { run(...params: unknown[]): unknown }
  exec(sql: string): unknown
}

/**
 * A test database opened through the production schema bootstrap.
 *
 * `cleanup` releases the connection and the on-disk files: the whole temp
 * directory when `createTestDb` allocated one, otherwise only the caller's
 * database file and its `-wal`/`-shm` companions.
 */
export interface TestDb {
  db: Database
  path: string
  cleanup(): void
}

function removeFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {}
}

function closeQuietly(db: Database): void {
  try {
    db.close()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/closed|not open/i.test(message)) throw err
  }
}

/**
 * Opens a throwaway database with every production migration applied.
 *
 * Without `path` the database lives in a fresh temp directory; with `path` the
 * caller owns the location and `cleanup` removes only that database's files.
 */
export function createTestDb(options: { path?: string } = {}): TestDb {
  const dir = options.path ? null : mkdtempSync(join(tmpdir(), 'forge-test-'))
  const path = options.path ?? join(dir!, 'forge.db')
  const db = openForgeDatabase(path)

  return {
    db,
    path,
    cleanup(): void {
      closeQuietly(db)
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      } else {
        removeFile(path)
        removeFile(`${path}-wal`)
        removeFile(`${path}-shm`)
      }
    },
  }
}

/**
 * Apply all production migrations to a fresh test DB so loops/loop_large_fields/
 * loop_session_usage/plans/review_findings/section_plans/tui_preferences schemas
 * match production. Use this instead of inline schema blocks so future
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
