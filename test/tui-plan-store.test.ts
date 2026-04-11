import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { resolvePlanKey, readPlan, writePlan, deletePlan } from '../src/utils/tui-plan-store'

const TEST_DIR = '/tmp/opencode-manager-tui-plan-test-' + Date.now()

function createTestDb(): Database {
  const dbPath = `${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`
  const db = new Database(dbPath)
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
  return { db, dbPath }
}

describe('TUI Plan Store', () => {
  let db: Database
  let dbPath: string
  const projectId = 'test-project'
  const sessionId = 'test-session-123'
  const planContent = '# Test Plan\n\nThis is a test plan.'

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    dbPath = result.dbPath
  })

  afterEach(() => {
    try { db.close() } catch {}
  })

  describe('resolvePlanKey', () => {
    test('Returns session-based key when no loop mapping exists', () => {
      const key = resolvePlanKey(projectId, sessionId, dbPath)
      expect(key).toBe(`plan:${sessionId}`)
    })

    test('Returns worktree-based key when loop-session mapping exists', () => {
      const worktreeName = 'test-worktree'
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      
      // Create loop-session mapping
      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, `loop-session:${sessionId}`, JSON.stringify(worktreeName), now + ttl, now, now)

      const key = resolvePlanKey(projectId, sessionId, dbPath)
      expect(key).toBe(`plan:${worktreeName}`)
    })

    test('Falls back to session key when loop-session mapping is expired', () => {
      const worktreeName = 'test-worktree'
      const expiredTime = Date.now() - 1000 // 1 second ago
      
      // Create expired loop-session mapping
      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, `loop-session:${sessionId}`, JSON.stringify(worktreeName), expiredTime, Date.now() - 2000, Date.now() - 2000)

      const key = resolvePlanKey(projectId, sessionId, dbPath)
      expect(key).toBe(`plan:${sessionId}`)
    })

    test('Handles missing database gracefully', () => {
      // Use a non-existent DB path
      const key = resolvePlanKey('non-existent-project', sessionId, '/non-existent/db.db')
      expect(key).toBe(`plan:${sessionId}`)
    })
  })

  describe('readPlan', () => {
    test('Returns null when no plan exists', () => {
      const result = readPlan(projectId, sessionId, dbPath)
      expect(result).toBeNull()
    })

    test('Reads plan from session-based key for non-loop sessions', () => {
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      
      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, `plan:${sessionId}`, JSON.stringify(planContent), now + ttl, now, now)

      const result = readPlan(projectId, sessionId, dbPath)
      expect(result).toBe(planContent)
    })

    test('Reads plan from worktree-based key for loop sessions', () => {
      const worktreeName = 'test-worktree'
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      
      // Create loop-session mapping
      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, `loop-session:${sessionId}`, JSON.stringify(worktreeName), now + ttl, now, now)
      
      // Create plan under worktree key
      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, `plan:${worktreeName}`, JSON.stringify(planContent), now + ttl, now, now)

      const result = readPlan(projectId, sessionId, dbPath)
      expect(result).toBe(planContent)
    })

    test('Handles JSON-encoded strings correctly', () => {
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      
      // The helper stores content as JSON.stringify(content), then unwraps on read
      // This test verifies the round-trip works correctly
      const written = writePlan(projectId, sessionId, planContent, dbPath)
      expect(written).toBe(true)

      const result = readPlan(projectId, sessionId, dbPath)
      expect(result).toBe(planContent)
    })
  })

  describe('writePlan', () => {
    test('Returns false when database does not exist', () => {
      const result = writePlan('non-existent-project', sessionId, planContent, '/non-existent/db.db')
      expect(result).toBe(false)
    })

    test('Writes plan with session-based key for non-loop sessions', () => {
      const result = writePlan(projectId, sessionId, planContent, dbPath)
      expect(result).toBe(true)

      const row = db.prepare(
        'SELECT data, key, created_at FROM project_kv WHERE project_id = ? AND key = ?'
      ).get(projectId, `plan:${sessionId}`) as { data: string; key: string; created_at: number } | null

      expect(row).toBeDefined()
      expect(row?.key).toBe(`plan:${sessionId}`)
      expect(JSON.parse(row?.data || 'null')).toBe(planContent)
      expect(row?.created_at).toBeDefined()
      expect(row!.created_at).toBeGreaterThan(0)
    })

    test('Writes plan with worktree-based key for loop sessions', () => {
      const worktreeName = 'test-worktree'
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      
      // Create loop-session mapping first
      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, `loop-session:${sessionId}`, JSON.stringify(worktreeName), now + ttl, now, now)

      const result = writePlan(projectId, sessionId, planContent, dbPath)
      expect(result).toBe(true)

      const row = db.prepare(
        'SELECT data, key, created_at FROM project_kv WHERE project_id = ? AND key = ?'
      ).get(projectId, `plan:${worktreeName}`) as { data: string; key: string; created_at: number } | null

      expect(row).toBeDefined()
      expect(row?.key).toBe(`plan:${worktreeName}`)
      expect(JSON.parse(row?.data || 'null')).toBe(planContent)
      expect(row?.created_at).toBeDefined()
      expect(row!.created_at).toBeGreaterThan(0)
    })
  })

  describe('deletePlan', () => {
    test('Returns false when database does not exist', () => {
      const result = deletePlan('non-existent-project', sessionId, '/non-existent/db.db')
      expect(result).toBe(false)
    })

    test('Deletes plan from session-based key for non-loop sessions', () => {
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      
      // Create plan
      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, `plan:${sessionId}`, JSON.stringify(planContent), now + ttl, now, now)

      const deleted = deletePlan(projectId, sessionId, dbPath)
      expect(deleted).toBe(true)

      const row = db.prepare(
        'SELECT data FROM project_kv WHERE project_id = ? AND key = ?'
      ).get(projectId, `plan:${sessionId}`)

      expect(row).toBeNull()
    })

    test('Deletes plan from worktree-based key for loop sessions', () => {
      const worktreeName = 'test-worktree'
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      
      // Create loop-session mapping
      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, `loop-session:${sessionId}`, JSON.stringify(worktreeName), now + ttl, now, now)
      
      // Create plan under worktree key
      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, `plan:${worktreeName}`, JSON.stringify(planContent), now + ttl, now, now)

      const deleted = deletePlan(projectId, sessionId, dbPath)
      expect(deleted).toBe(true)

      const row = db.prepare(
        'SELECT data FROM project_kv WHERE project_id = ? AND key = ?'
      ).get(projectId, `plan:${worktreeName}`)

      expect(row).toBeNull()
    })

    test('Returns false when plan does not exist', () => {
      const deleted = deletePlan(projectId, sessionId, dbPath)
      expect(deleted).toBe(false)
    })
  })
})
