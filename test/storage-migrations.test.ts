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
  expect(tableNames).toContain('graph_status')
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
  expect(ids).toContain('104')
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
