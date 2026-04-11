import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { initializeGraphDatabase, closeGraphDatabase } from '../src/graph/database'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'

const TEST_DATA_DIR = '/tmp/opencode-graph-db-test-' + Date.now()

describe('Graph database initialization', () => {
  let testProjectId: string
  let testDataDir: string

  beforeEach(() => {
    testProjectId = 'test-project-' + Date.now()
    testDataDir = join(TEST_DATA_DIR, Math.random().toString(36).slice(2))
    mkdirSync(testDataDir, { recursive: true })
  })

  afterEach(() => {
    closeGraphDatabase()
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('should initialize database idempotently without throwing', () => {
    // First initialization
    const db1 = initializeGraphDatabase(testProjectId, testDataDir)
    expect(db1).toBeDefined()

    // Second initialization should not throw
    const db2 = initializeGraphDatabase(testProjectId, testDataDir)
    expect(db2).toBeDefined()

    // Third initialization should also not throw
    const db3 = initializeGraphDatabase(testProjectId, testDataDir)
    expect(db3).toBeDefined()

    closeGraphDatabase()
  })

  test('should create semantic_summaries table with correct schema', () => {
    const db = initializeGraphDatabase(testProjectId, testDataDir)
    
    // Check table exists
    const tableInfo = db.prepare("PRAGMA table_info(semantic_summaries)").all() as Array<{ name: string; type: string; pk: number }>
    expect(tableInfo.length).toBeGreaterThan(0)
    
    // Verify composite primary key (symbol_id, source)
    const pkColumns = tableInfo.filter(col => col.pk > 0)
    expect(pkColumns.length).toBe(2)
    
    const pkNames = pkColumns.map(col => col.name).sort()
    expect(pkNames).toEqual(['source', 'symbol_id'])
    
    // Verify 'id' column does NOT exist (old schema)
    const hasIdColumn = tableInfo.some(col => col.name === 'id')
    expect(hasIdColumn).toBe(false)

    closeGraphDatabase()
  })

  test('should handle old schema migration correctly', () => {
    const db = initializeGraphDatabase(testProjectId, testDataDir)
    
    // Simulate old schema by dropping and recreating with 'id' primary key
    db.run(`DROP TABLE IF EXISTS semantic_summaries`)
    db.run(`
      CREATE TABLE semantic_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        summary TEXT NOT NULL
      )
    `)

    // Re-initialize should migrate to new schema
    closeGraphDatabase()
    
    const db2 = initializeGraphDatabase(testProjectId, testDataDir)
    const tableInfo = db2.prepare("PRAGMA table_info(semantic_summaries)").all() as Array<{ name: string; pk: number }>
    
    // Verify 'id' column was removed
    const hasIdColumn = tableInfo.some(col => col.name === 'id')
    expect(hasIdColumn).toBe(false)
    
    // Verify composite primary key exists
    const pkColumns = tableInfo.filter(col => col.pk > 0)
    expect(pkColumns.length).toBe(2)

    closeGraphDatabase()
  })

  test('should preserve data when table already has correct schema', () => {
    const db = initializeGraphDatabase(testProjectId, testDataDir)
    
    // Insert test data - first create a file
    db.run(`INSERT INTO files (path, mtime_ms, language, line_count, symbol_count, pagerank, is_barrel, indexed_at) VALUES ('/test.ts', 123, 'typescript', 10, 1, 0.5, 0, 123)`)
    const fileId = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }
    
    // Then create a symbol
    db.run(`INSERT INTO symbols (file_id, name, kind, line, end_line, is_exported) VALUES (?, 'test', 'function', 1, 5, 1)`, [fileId.id])
    const symbolId = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }
    
    db.run(`
      INSERT INTO semantic_summaries (symbol_id, source, summary, file_mtime, file_path, symbol_name)
      VALUES (?, 'test', 'summary', 123, '/test.ts', 'test')
    `, [symbolId.id])

    // Re-initialize
    closeGraphDatabase()
    const db2 = initializeGraphDatabase(testProjectId, testDataDir)
    
    // Verify data still exists
    const count = db2.prepare('SELECT COUNT(*) as count FROM semantic_summaries').get() as { count: number }
    expect(count.count).toBe(1)

    closeGraphDatabase()
  })

  test('should create index on semantic_summaries table', () => {
    const db = initializeGraphDatabase(testProjectId, testDataDir)
    
    // Check index exists
    const indexInfo = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='semantic_summaries'
    `).all() as Array<{ name: string }>
    
    const hasIndex = indexInfo.some(idx => idx.name === 'idx_semantic_summaries_symbol_id')
    expect(hasIndex).toBe(true)

    closeGraphDatabase()
  })
})
