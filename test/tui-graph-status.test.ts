import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { initializeDatabase, closeDatabase } from '../src/storage'
import { readGraphStatus, formatGraphStatus, getDbPathForDataDir, isTransient, waitForGraphReady } from '../src/utils/tui-graph-status'
import { GRAPH_STATUS_KEY, getGraphStatusKey } from '../src/utils/graph-status-store'
import type { GraphStatusPayload } from '../src/utils/graph-status-store'

const TEST_DIR = '/tmp/opencode-tui-graph-status-test-' + Date.now()

function createTestLogger() {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('TUI graph status helper', () => {
  let testDir: string
  let testDataDir: string
  let testProjectId: string
  let db: Database
  let dbPath: string

  beforeEach(() => {
    testDir = TEST_DIR + '-' + Math.random().toString(36).slice(2)
    testDataDir = join(testDir, 'data')
    testProjectId = 'test-project-' + Date.now()
    mkdirSync(testDir, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    
    // Set up KV service - initializeDatabase creates the DB and tables
    db = initializeDatabase(testDataDir)
    // The database is created at testDataDir/graph.db
    dbPath = join(testDataDir, 'graph.db')
    
    // Verify database exists and has the table
    expect(existsSync(dbPath)).toBe(true)
  })

  afterEach(async () => {
    closeDatabase(db)
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('readGraphStatus', () => {
    test('should return null when database does not exist', () => {
      const nonExistentPath = '/nonexistent/path/graph.db'
      const result = readGraphStatus(testProjectId, nonExistentPath)
      expect(result).toBeNull()
    })

    test('should return null when status key does not exist', () => {
      const result = readGraphStatus(testProjectId, dbPath)
      expect(result).toBeNull()
    })

    test('should read status from KV store', () => {
      // Write status directly to the database using the db from beforeEach
      const status: GraphStatusPayload = {
        state: 'ready',
        ready: true,
        stats: {
          files: 10,
          symbols: 50,
          edges: 100,
          calls: 25,
        },
        updatedAt: Date.now(),
      }
      
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(testProjectId, GRAPH_STATUS_KEY, JSON.stringify(status), now + ttl, now, now)
      
      // Read it back using the same db path
      const result = readGraphStatus(testProjectId, dbPath)
      expect(result).toBeDefined()
      expect(result?.state).toBe('ready')
      expect(result?.ready).toBe(true)
      expect(result?.stats?.files).toBe(10)
    })

    test('should return null for malformed JSON', () => {
      // Use the already-initialized database from beforeEach
      // Manually write malformed data
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(testProjectId, GRAPH_STATUS_KEY, 'invalid json', now + ttl, now, now)
      
      // Read it back - should return null due to JSON parse error
      const result = readGraphStatus(testProjectId, dbPath)
      expect(result).toBeNull()
    })

    test('should handle expired entries', () => {
      // Use the already-initialized database from beforeEach
      // Write with expired timestamp
      const expiredTime = Date.now() - 1000 // 1 second ago
      const jsonData = JSON.stringify({ state: 'ready', ready: true })
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(testProjectId, GRAPH_STATUS_KEY, jsonData, expiredTime, expiredTime, expiredTime)
      
      // Read it back - should return null due to expired timestamp
      const result = readGraphStatus(testProjectId, dbPath)
      expect(result).toBeNull()
    })
  })

  describe('formatGraphStatus', () => {
    test('should format ready state with stats', () => {
      const status: GraphStatusPayload = {
        state: 'ready',
        ready: true,
        stats: {
          files: 42,
          symbols: 100,
          edges: 200,
          calls: 50,
        },
        updatedAt: Date.now(),
      }
      
      const result = formatGraphStatus(status)
      expect(result.text).toBe('ready · 42 files')
      expect(result.color).toBe('success')
    })

    test('should format ready state without stats', () => {
      const status: GraphStatusPayload = {
        state: 'ready',
        ready: true,
        updatedAt: Date.now(),
      }
      
      const result = formatGraphStatus(status)
      expect(result.text).toBe('ready')
      expect(result.color).toBe('success')
    })

    test('should format indexing state', () => {
      const status: GraphStatusPayload = {
        state: 'indexing',
        ready: false,
        updatedAt: Date.now(),
      }
      
      const result = formatGraphStatus(status)
      expect(result.text).toBe('indexing')
      expect(result.color).toBe('warning')
    })

    test('should format initializing state', () => {
      const status: GraphStatusPayload = {
        state: 'initializing',
        ready: false,
        updatedAt: Date.now(),
      }
      
      const result = formatGraphStatus(status)
      expect(result.text).toBe('initializing')
      expect(result.color).toBe('info')
    })

    test('should format error state', () => {
      const status: GraphStatusPayload = {
        state: 'error',
        ready: false,
        message: 'Worker initialization failed',
        updatedAt: Date.now(),
      }
      
      const result = formatGraphStatus(status)
      expect(result.text).toBe('error')
      expect(result.color).toBe('error')
    })

    test('should format unavailable state', () => {
      const status: GraphStatusPayload = {
        state: 'unavailable',
        ready: false,
        updatedAt: Date.now(),
      }
      
      const result = formatGraphStatus(status)
      expect(result.text).toBe('unavailable')
      expect(result.color).toBe('textMuted')
    })

    test('should format null as unavailable', () => {
      const result = formatGraphStatus(null)
      expect(result.text).toBe('unavailable')
      expect(result.color).toBe('textMuted')
    })
  })

  describe('isTransient', () => {
    test('should return true for initializing state', () => {
      const status: GraphStatusPayload = {
        state: 'initializing',
        ready: false,
        updatedAt: Date.now(),
      }
      expect(isTransient(status)).toBe(true)
    })

    test('should return true for indexing state', () => {
      const status: GraphStatusPayload = {
        state: 'indexing',
        ready: false,
        updatedAt: Date.now(),
      }
      expect(isTransient(status)).toBe(true)
    })

    test('should return false for ready state', () => {
      const status: GraphStatusPayload = {
        state: 'ready',
        ready: true,
        stats: { files: 10, symbols: 50, edges: 100, calls: 25 },
        updatedAt: Date.now(),
      }
      expect(isTransient(status)).toBe(false)
    })

    test('should return false for error state', () => {
      const status: GraphStatusPayload = {
        state: 'error',
        ready: false,
        message: 'Worker initialization failed',
        updatedAt: Date.now(),
      }
      expect(isTransient(status)).toBe(false)
    })

    test('should return false for unavailable state', () => {
      const status: GraphStatusPayload = {
        state: 'unavailable',
        ready: false,
        updatedAt: Date.now(),
      }
      expect(isTransient(status)).toBe(false)
    })

    test('should return false for null', () => {
      expect(isTransient(null)).toBe(false)
    })
  })

  describe('getGraphStatusKey', () => {
    test('should return base key without cwd', () => {
      expect(getGraphStatusKey()).toBe('graph:status')
    })

    test('should return scoped key with cwd', () => {
      const cwd = '/path/to/worktree'
      expect(getGraphStatusKey(cwd)).toBe('graph:status:/path/to/worktree')
    })

    test('should normalize trailing slashes in cwd', () => {
      const cwd1 = '/path/to/worktree'
      const cwd2 = '/path/to/worktree/'
      expect(getGraphStatusKey(cwd1)).toBe(getGraphStatusKey(cwd2))
    })
  })

  describe('scoped status isolation', () => {
    test('should store separate status for root vs worktree', () => {
      const rootStatus: GraphStatusPayload = {
        state: 'ready',
        ready: true,
        stats: { files: 10, symbols: 50, edges: 100, calls: 25 },
        updatedAt: Date.now(),
      }
      const worktreeStatus: GraphStatusPayload = {
        state: 'indexing',
        ready: false,
        updatedAt: Date.now(),
      }

      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      
      // Write root status
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(testProjectId, 'graph:status', JSON.stringify(rootStatus), now + ttl, now, now)
      
      // Write worktree status with scoped key
      const worktreeKey = getGraphStatusKey('/tmp/worktree-test')
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(testProjectId, worktreeKey, JSON.stringify(worktreeStatus), now + ttl, now, now)
      
      // Read root status - should get root status
      const rootRead = readGraphStatus(testProjectId, dbPath)
      expect(rootRead?.state).toBe('ready')
      
      // Read worktree status - should get worktree status
      const worktreeRead = readGraphStatus(testProjectId, dbPath, '/tmp/worktree-test')
      expect(worktreeRead?.state).toBe('indexing')
    })
  })

  describe('waitForGraphReady', () => {
    test('should return immediately when status is ready', async () => {
      const readyStatus: GraphStatusPayload = {
        state: 'ready',
        ready: true,
        stats: { files: 10, symbols: 50, edges: 100, calls: 25 },
        updatedAt: Date.now(),
      }

      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(testProjectId, 'graph:status', JSON.stringify(readyStatus), now + ttl, now, now)

      const result = await waitForGraphReady(testProjectId, { dbPathOverride: dbPath, pollMs: 10, timeoutMs: 100 })
      expect(result).not.toBe('timeout')
      if (result !== 'timeout' && result !== null) {
        expect(result.state).toBe('ready')
      }
    })

    test('should timeout when status stays in transient state', async () => {
      const indexingStatus: GraphStatusPayload = {
        state: 'indexing',
        ready: false,
        updatedAt: Date.now(),
      }

      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(testProjectId, 'graph:status', JSON.stringify(indexingStatus), now + ttl, now, now)

      const result = await waitForGraphReady(testProjectId, { dbPathOverride: dbPath, pollMs: 10, timeoutMs: 50 })
      expect(result).toBe('timeout')
    })

    test('should return null when status is missing after short timeout', async () => {
      const result = await waitForGraphReady('nonexistent-project', { dbPathOverride: '/nonexistent/db', pollMs: 10, timeoutMs: 5000 })
      expect(result).toBeNull()
    })

    test('should wait on worktree scope, not root scope', async () => {
      const worktreeCwd = '/tmp/worktree-scope-test'
      const worktreeKey = getGraphStatusKey(worktreeCwd)
      
      const indexingStatus: GraphStatusPayload = {
        state: 'indexing',
        ready: false,
        updatedAt: Date.now(),
      }

      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      // Write indexing status to worktree scope
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(testProjectId, worktreeKey, JSON.stringify(indexingStatus), now + ttl, now, now)

      // Wait on worktree scope - should timeout because status stays indexing
      const worktreeResult = await waitForGraphReady(testProjectId, { 
        dbPathOverride: dbPath, 
        cwd: worktreeCwd,
        pollMs: 10, 
        timeoutMs: 50 
      })
      expect(worktreeResult).toBe('timeout')
    })
  })
})
