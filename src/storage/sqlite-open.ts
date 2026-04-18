import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { dirname } from 'path'

export interface SqliteOpenOptions {
  /** Bootstrap schema (runs on every successful open — must be idempotent, e.g. CREATE TABLE IF NOT EXISTS). */
  bootstrap: (db: Database) => void
  /** Pragmas to run after open and on fresh-db creation. */
  pragmas: string[]
  /** Human-readable label used in error logging (e.g. "Forge database" or "Graph database"). */
  label: string
  /**
   * Optional additional validation after the integrity_check.
   * Throw to trigger corruption recovery. Called with the opened db.
   */
  validate?: (db: Database) => void
  /**
   * Hook called before opening, for non-destructive cleanup of inconsistent
   * on-disk state (e.g. orphaned SHM files). Receives the dbPath.
   */
  preOpenCleanup?: (dbPath: string) => void
  /**
   * When true, `createFreshDatabase` will `mkdirSync(dirname(dbPath), { recursive: true })`
   * before opening. Set false for callers that manage directory creation themselves.
   */
  ensureParentDir?: boolean
}

function deleteDatabaseFiles(dbPath: string): void {
  try {
    unlinkSync(dbPath)
  } catch {}
  try {
    unlinkSync(dbPath + '-wal')
  } catch {}
  try {
    unlinkSync(dbPath + '-shm')
  } catch {}
}

function isCorruptionMessage(errorMsg: string): boolean {
  return (
    errorMsg.includes('database disk image is malformed') ||
    errorMsg.includes('corrupt') ||
    errorMsg.includes('SQLITE_CORRUPT') ||
    errorMsg.includes('file is not a database')
  )
}

function applyPragmas(db: Database, pragmas: readonly string[]): void {
  for (const p of pragmas) db.run(p)
}

function createFreshDatabase(dbPath: string, options: SqliteOpenOptions): Database {
  if (options.ensureParentDir) {
    const parentDir = dirname(dbPath)
    if (parentDir && parentDir !== '.' && parentDir !== '/') {
      mkdirSync(parentDir, { recursive: true })
    }
  }

  const freshDb = new Database(dbPath)
  applyPragmas(freshDb, options.pragmas)
  options.bootstrap(freshDb)
  return freshDb
}

/**
 * Opens a SQLite database with integrity verification and corruption recovery.
 *
 * - Runs `PRAGMA integrity_check` after open.
 * - Optionally runs a caller-supplied `validate` hook for deeper checks
 *   (e.g. exercising data pages — catches WAL-level corruption that
 *   integrity_check can miss).
 * - On integrity failure OR a corruption error during open, deletes the
 *   DB + WAL + SHM files and recreates a fresh database via `bootstrap`.
 * - Non-corruption errors during open are re-thrown for the caller to handle.
 */
export function openSqliteWithIntegrityGuard(
  dbPath: string,
  options: SqliteOpenOptions,
): Database {
  options.preOpenCleanup?.(dbPath)

  let db: Database | null = null
  let needsBootstrap = false

  try {
    db = new Database(dbPath)
    applyPragmas(db, options.pragmas)

    // Run integrity check
    const integrityResult = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (integrityResult.integrity_check !== 'ok') {
      db.close()
      console.error(`${options.label} corruption detected at ${dbPath}: ${integrityResult.integrity_check}`)
      deleteDatabaseFiles(dbPath)
      needsBootstrap = true
      db = null
    }

    // Additional caller-supplied validation (e.g. query a real table to catch WAL-level corruption)
    if (db && options.validate) {
      try {
        options.validate(db)
      } catch (validateErr) {
        db.close()
        const msg = validateErr instanceof Error ? validateErr.message : String(validateErr)
        console.error(`${options.label} validation failed at ${dbPath}: ${msg}`)
        deleteDatabaseFiles(dbPath)
        needsBootstrap = true
        db = null
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error(`${options.label} open failed at ${dbPath}: ${errorMsg}`)

    // Close db handle if it was opened before failing
    if (db) {
      try {
        db.close()
      } catch {}
      db = null
    }

    if (isCorruptionMessage(errorMsg)) {
      deleteDatabaseFiles(dbPath)
      needsBootstrap = true
    } else {
      // Re-throw transient errors (e.g. SQLITE_BUSY) so the caller can retry
      throw err
    }
  }

  if (needsBootstrap || db === null) {
    return createFreshDatabase(dbPath, options)
  }

  // Bootstrap schema on every open — must be idempotent
  options.bootstrap(db)
  return db
}

/** Best-effort removal of an orphaned SHM file when its WAL sibling is missing. */
export function cleanupOrphanedShmFile(dbPath: string): void {
  try {
    const shmPath = dbPath + '-shm'
    const walPath = dbPath + '-wal'
    if (existsSync(shmPath) && !existsSync(walPath)) {
      console.debug(`Removing orphaned SHM file for ${dbPath}`)
      try { unlinkSync(shmPath) } catch {}
    }
  } catch {}
}
