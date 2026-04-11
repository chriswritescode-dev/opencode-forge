import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'

interface Migration {
  id: string
  description: string
  apply: (db: Database) => void
}

const migrations: Migration[] = [
  {
    id: '001',
    description: 'Remove status column from memories table',
    apply: (db: Database) => {
      const tableInfo = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
      const hasStatusColumn = tableInfo.some((col) => col.name === 'status')
      
      if (!hasStatusColumn) {
        return
      }

      try {
        db.run('ALTER TABLE memories DROP COLUMN status')
      } catch {
        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'").all() as Array<{ name: string }>
        for (const idx of indexes) {
          if (idx.name.includes('status')) {
            db.run(`DROP INDEX IF EXISTS ${idx.name}`)
          }
        }
        db.run('ALTER TABLE memories DROP COLUMN status')
      }
    },
  },
]

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
      migration.apply(db)
      db.prepare('INSERT INTO migrations (id, description, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.description,
        Date.now()
      )
    }
  }
}

export function resolveDataDir(): string {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
  const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
  const forgeDir = join(xdgDataHome, 'opencode', 'forge')
  const legacyGraphDir = join(xdgDataHome, 'opencode', 'graph')
  return existsSync(legacyGraphDir) && !existsSync(forgeDir) ? legacyGraphDir : forgeDir
}

export function resolveLogPath(): string {
  return join(resolveDataDir(), 'logs', 'forge.log')
}

export function initializeDatabase(dataDir: string): Database {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  const dbPath = `${dataDir}/graph.db`
  const db = new Database(dbPath)

  db.run('PRAGMA journal_mode=WAL')
  db.run('PRAGMA busy_timeout=5000')
  db.run('PRAGMA synchronous=NORMAL')

  runMigrations(db)

  db.run(`
    CREATE TABLE IF NOT EXISTS plugin_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS project_kv (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `)

  db.run(`CREATE INDEX IF NOT EXISTS idx_project_kv_expires_at ON project_kv(expires_at)`)

  return db
}

export function closeDatabase(db: Database): void {
  db.close()
}
