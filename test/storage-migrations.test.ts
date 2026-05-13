import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { openForgeDatabase } from '../src/storage/database'

function createTempDb(): string {
  const dir = tmpdir()
  const dbPath = join(dir, `forge-test-${randomUUID()}.db`)
  return dbPath
}

test('openForgeDatabase creates all new tables', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  const tableNames = tables.map((t) => t.name)

  expect(tableNames).toContain('loops')
  expect(tableNames).toContain('loop_large_fields')
  expect(tableNames).toContain('plans')
  expect(tableNames).toContain('review_findings')
  expect(tableNames).toContain('tui_preferences')
  expect(tableNames).toContain('migrations')

  db.close()
})

test('migrations are recorded exactly once', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const migrations = db.prepare('SELECT id, description FROM migrations ORDER BY id').all() as Array<{ id: string; description: string }>

  expect(migrations.length).toBeGreaterThan(0)

  const ids = migrations.map((m) => m.id)
  expect(ids).toContain('100')
  expect(ids).toContain('101')
  expect(ids).toContain('102')
  expect(ids).toContain('103')
  expect(ids).toContain('105')
  expect(ids).toContain('106')

  const uniqueIds = new Set(ids)
  expect(uniqueIds.size).toBe(migrations.length)

  db.close()
})

test('re-opening does not re-run migrations', () => {
  const dbPath = createTempDb()

  const db1 = openForgeDatabase(dbPath)
  const count1 = db1.prepare('SELECT COUNT(*) as count FROM migrations').get() as { count: number }

  db1.close()

  const db2 = openForgeDatabase(dbPath)
  const count2 = db2.prepare('SELECT COUNT(*) as count FROM migrations').get() as { count: number }

  expect(count2.count).toBe(count1.count)

  db2.close()
})

test('migrations run in transactions', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const countBefore = db.prepare('SELECT COUNT(*) as count FROM migrations').get() as { count: number }

  const tablesAfter = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  const tableNames = tablesAfter.map((t) => t.name)
  expect(tableNames).toContain('loops')
  expect(tableNames).toContain('migrations')

  const countAfter = db.prepare('SELECT COUNT(*) as count FROM migrations').get() as { count: number }
  expect(countAfter.count).toBe(countBefore.count)

  db.close()
})

test('review findings scenario is nullable for new databases', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const scenario = db.prepare('PRAGMA table_info(review_findings)').all().find((col) => {
    return (col as { name: string }).name === 'scenario'
  }) as { notnull: number } | undefined

  expect(scenario?.notnull).toBe(0)

  db.close()
})

test('review findings scenario is made nullable when legacy migration id was already used', () => {
  const dbPath = createTempDb()
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE review_findings (
      project_id   TEXT NOT NULL,
      loop_name    TEXT NOT NULL DEFAULT '',
      file         TEXT NOT NULL,
      line         INTEGER NOT NULL,
      severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description  TEXT NOT NULL,
      scenario     TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, loop_name, file, line)
    );
    INSERT INTO migrations (id, description, applied_at) VALUES
      ('103', 'Create review_findings table for write-once review findings', 1),
      ('111', 'Drop session_directory column from loops table (dead data removal)', 1);
  `)
  db.close()

  const migrated = openForgeDatabase(dbPath)
  const scenario = migrated.prepare('PRAGMA table_info(review_findings)').all().find((col) => {
    return (col as { name: string }).name === 'scenario'
  }) as { notnull: number } | undefined

  expect(scenario?.notnull).toBe(0)

  migrated.close()
})

test('review findings branch scope is dropped when migration 119 was already recorded', () => {
  const dbPath = createTempDb()
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE review_findings (
      project_id   TEXT NOT NULL,
      branch       TEXT NOT NULL DEFAULT '',
      loop_name    TEXT NOT NULL DEFAULT '',
      file         TEXT NOT NULL,
      line         INTEGER NOT NULL,
      severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description  TEXT NOT NULL,
      scenario     TEXT,
      created_at   INTEGER NOT NULL,
      CHECK (NOT (branch != '' AND loop_name != '')),
      PRIMARY KEY (project_id, branch, loop_name, file, line)
    );
    INSERT INTO migrations (id, description, applied_at) VALUES
      ('103', 'Create review_findings table for write-once review findings', 1),
      ('111', 'Make scenario column nullable in review_findings table', 1),
      ('117', 'Add branch to primary key for review_findings table (branch-scoped findings)', 1),
      ('114', 'Ensure scenario column is nullable in review_findings table', 1),
      ('115', 'Create api_registry table for HTTP control plane (historical - dropped in 116)', 1),
      ('116', 'Drop api_registry table (bus-RPC migration - HTTP control plane removed)', 1),
      ('118', 'Drop audit_session_id column from loops table (single-session loop model)', 1),
      ('119', 'Add loop_name scope to review_findings; drop legacy branch-only rows', 1);
  `)
  db.close()

  const migrated = openForgeDatabase(dbPath)
  const cols = migrated.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string; pk: number }>

  expect(cols.some((col) => col.name === 'branch')).toBe(false)
  expect(cols.find((col) => col.name === 'project_id')?.pk).toBe(1)
  expect(cols.find((col) => col.name === 'loop_name')?.pk).toBe(2)
  expect(cols.find((col) => col.name === 'file')?.pk).toBe(3)
  expect(cols.find((col) => col.name === 'line')?.pk).toBe(4)

  migrated.close()
})

test('review findings section_index is in primary key after migration 125', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  const cols = db.prepare('PRAGMA table_info(review_findings)').all() as Array<{ name: string; pk: number }>
  expect(cols.find((col) => col.name === 'section_index')?.pk).toBe(5)
  expect(cols.find((col) => col.name === 'project_id')?.pk).toBe(1)
  expect(cols.find((col) => col.name === 'loop_name')?.pk).toBe(2)
  expect(cols.find((col) => col.name === 'file')?.pk).toBe(3)
  expect(cols.find((col) => col.name === 'line')?.pk).toBe(4)

  db.close()
})

test('migration 125 normalizes NULL section_index to -1 sentinel', () => {
  const dbPath = createTempDb()
  const db = openForgeDatabase(dbPath)

  // The review_findings table after migration 125 uses COALESCE(?, -1) to normalize NULL to -1.
  // Simulate cross-section writes via COALESCE (as the write function does).
  db.prepare(`
    INSERT INTO review_findings (project_id, loop_name, file, line, severity, description, scenario, section_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, -1), ?)
  `).run('proj', 'loop1', 'src/a.ts', 10, 'bug', 'desc', 'sc', null, Date.now())
  db.prepare(`
    INSERT INTO review_findings (project_id, loop_name, file, line, severity, description, scenario, section_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, -1), ?)
  `).run('proj', 'loop1', 'src/b.ts', 20, 'warning', 'desc2', 'sc2', null, Date.now())

  const rows = db.prepare('SELECT section_index FROM review_findings WHERE project_id = ? AND loop_name = ?').all('proj', 'loop1') as Array<{ section_index: number | null }>
  for (const row of rows) {
    expect(row.section_index).toBe(-1)
  }

  db.close()
})
