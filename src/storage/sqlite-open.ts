import { Database } from 'bun:sqlite'
import { mkdirSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'

const integrityCheckRowSchema = z.object({ integrity_check: z.string() })
const statementChangesResultSchema = z.object({ changes: z.number() })

export function statementChanges(result: void): number {
  const parsed = statementChangesResultSchema.safeParse(result)
  return parsed.success ? parsed.data.changes : 0
}

interface ImmediateTransactionRunner<T> {
  immediate: () => T
}

type TransactionCallable<T> = () => T

function hasImmediateRunner<T>(
  transaction: TransactionCallable<T>,
): transaction is TransactionCallable<T> & ImmediateTransactionRunner<T> {
  return 'immediate' in transaction
}

interface SqliteOpenOptions {
  bootstrap: (db: Database) => void
  pragmas: string[]
  label: string
  validate?: (db: Database) => void
  preOpenCleanup?: (dbPath: string) => void
  ensureParentDir?: boolean
}

export function runImmediateTransaction<T>(db: Database, fn: () => T): T {
  const transaction = db.transaction(fn)
  return hasImmediateRunner<T>(transaction) ? transaction.immediate() : transaction()
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

    const integrityResult = integrityCheckRowSchema.parse(db.prepare('PRAGMA integrity_check').get())
    if (integrityResult.integrity_check !== 'ok') {
      db.close()
      console.error(`${options.label} corruption detected at ${dbPath}: ${integrityResult.integrity_check}`)
      deleteDatabaseFiles(dbPath)
      needsBootstrap = true
      db = null
    }

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
      throw err
    }
  }

  if (needsBootstrap || db === null) {
    return createFreshDatabase(dbPath, options)
  }

  options.bootstrap(db)
  return db
}


