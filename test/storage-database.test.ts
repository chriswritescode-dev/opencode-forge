import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { initializeDatabase, closeDatabase, resolveDataDir } from '../src/storage/database'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'

const TEST_DATA_DIR = '/tmp/opencode-storage-db-test-' + Date.now()

describe('Storage database corruption recovery', () => {
  let testDataDir: string

  beforeEach(() => {
    testDataDir = join(TEST_DATA_DIR, Math.random().toString(36).slice(2))
    mkdirSync(testDataDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('should recover from corrupted database and recreate schema', () => {
    // Initialize a fresh database
    const db = initializeDatabase(testDataDir)
    
    // Verify initial state - tables should exist
    const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    const tableNames = tablesBefore.map(t => t.name)
    expect(tableNames).toContain('migrations')
    expect(tableNames).toContain('loops')
    expect(tableNames).toContain('tui_preferences')
    
    closeDatabase(db)

    // Corrupt the database file
    const dbPath = join(testDataDir, 'graph.db')
    writeFileSync(dbPath, 'CORRUPTED DATA THAT IS NOT A VALID SQLITE FILE')

    // Reopen should recover and recreate
    const recoveredDb = initializeDatabase(testDataDir)
    
    // Verify tables exist after recovery
    const tablesAfter = recoveredDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    const tableNamesAfter = tablesAfter.map(t => t.name)
    expect(tableNamesAfter).toContain('migrations')
    expect(tableNamesAfter).toContain('loops')
    expect(tableNamesAfter).toContain('tui_preferences')

    closeDatabase(recoveredDb)
  })

  test('should be able to insert and read data after recovery', () => {
    // Initialize and then corrupt
    const db = initializeDatabase(testDataDir)
    closeDatabase(db)

    const dbPath = join(testDataDir, 'graph.db')
    writeFileSync(dbPath, 'CORRUPTED DATA')

    // Recover
    const recoveredDb = initializeDatabase(testDataDir)
    
    // Insert a test row using tui_preferences table
    const testProjectId = 'test-project'
    const testKey = 'test:key'
    const testData = JSON.stringify({ value: 'test-value' })
    const now = Date.now()
    
    recoveredDb.run(
      'INSERT OR REPLACE INTO tui_preferences (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [testProjectId, testKey, testData, now + 86400000, now]
    )

    // Read it back
    const result = recoveredDb.prepare(
      'SELECT data FROM tui_preferences WHERE project_id = ? AND key = ?'
    ).get(testProjectId, testKey) as { data: string }
    
    expect(result).toBeDefined()
    expect(JSON.parse(result.data)).toEqual({ value: 'test-value' })

    closeDatabase(recoveredDb)
  })

  test('should handle WAL and SHM file cleanup during recovery', () => {
    // Initialize database (creates WAL files)
    const db = initializeDatabase(testDataDir)
    const dbPath = join(testDataDir, 'graph.db')
    
    // Do some writes to ensure WAL files exist
    db.run('PRAGMA wal_checkpoint(TRUNCATE)')
    closeDatabase(db)

    // Corrupt the main database file
    writeFileSync(dbPath, 'CORRUPTED DATA')
    
    // WAL/SHM files may or may not exist depending on checkpoint, but recovery should handle all
    const recoveredDb = initializeDatabase(testDataDir)
    
    // Verify recovery succeeded
    const tables = recoveredDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.length).toBeGreaterThan(0)

    closeDatabase(recoveredDb)
  })
})
