import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import { openSqliteWithIntegrityGuard } from './sqlite-open'
import { migrations } from './migrations'
import { sweepExpiredLoops } from './sweep'

const FORGE_PRAGMAS = [
  'PRAGMA foreign_keys=ON',
  'PRAGMA journal_mode=WAL',
  'PRAGMA busy_timeout=5000',
  'PRAGMA synchronous=NORMAL',
]

export function resolveDataDir(): string {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
  const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
  return join(xdgDataHome, 'opencode', 'forge')
}

export function resolveLogPath(): string {
  return join(resolveDataDir(), 'logs', 'forge.log')
}

function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)

  for (const migration of migrations) {
    const existing = db.prepare('SELECT id FROM migrations WHERE id = ?').get(migration.id)
    if (!existing) {
      try {
        db.run('BEGIN')
        migration.apply(db)
        db.prepare('INSERT INTO migrations (id, description, applied_at) VALUES (?, ?, ?)').run(
          migration.id,
          migration.description,
          Date.now()
        )
        db.run('COMMIT')
      } catch (err) {
        db.run('ROLLBACK')
        throw err
      }
    }
  }
}

function bootstrapForgeSchema(db: Database): void {
  runMigrations(db)
}

interface ForgeDatabaseOptions {
  completedLoopTtlMs?: number
}

const DEFAULT_COMPLETED_LOOP_TTL_MS = 7 * 24 * 60 * 60 * 1000

type CachedDb = { db: Database; refCount: number }
const dbCache = new Map<string, CachedDb>()

function cacheKey(dbPath: string, options?: ForgeDatabaseOptions): string {
  return `${dbPath}::${options?.completedLoopTtlMs ?? DEFAULT_COMPLETED_LOOP_TTL_MS}`
}

export function openForgeDatabase(dbPath: string, options?: ForgeDatabaseOptions): Database {
  const db = openSqliteWithIntegrityGuard(dbPath, {
    label: 'Forge database',
    pragmas: FORGE_PRAGMAS,
    bootstrap: bootstrapForgeSchema,
    ensureParentDir: true,
  })

  const ttlMs = options?.completedLoopTtlMs ?? DEFAULT_COMPLETED_LOOP_TTL_MS
  sweepExpiredLoops(db, ttlMs)

  return db
}

export function initializeDatabase(dataDir: string, options?: ForgeDatabaseOptions): Database {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  const dbPath = `${dataDir}/forge.db`
  const key = cacheKey(dbPath, options)
  const cached = dbCache.get(key)
  if (cached) {
    cached.refCount += 1
    return cached.db
  }
  const db = openForgeDatabase(dbPath, options)
  dbCache.set(key, { db, refCount: 1 })
  return db
}

export function closeDatabase(db: Database): void {
  for (const [key, entry] of dbCache) {
    if (entry.db !== db) continue
    entry.refCount -= 1
    if (entry.refCount <= 0) {
      dbCache.delete(key)
      db.close()
    }
    return
  }
  db.close()
}
