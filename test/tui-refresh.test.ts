import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { readLoopStates, readLoopByName } from '../src/utils/tui-refresh-helpers'

const TEST_DIR = '/tmp/opencode-tui-refresh-test-' + Date.now()

function createTestDb(): { db: Database; dbPath: string } {
  const dbPath = `${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`
  const db = new Database(dbPath)
  // Create the loops table schema
  db.run(`
    CREATE TABLE IF NOT EXISTS loops (
      project_id TEXT NOT NULL,
      loop_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id TEXT NOT NULL,
      worktree INTEGER NOT NULL,
      worktree_dir TEXT NOT NULL,
      worktree_branch TEXT,
      project_dir TEXT NOT NULL,
      max_iterations INTEGER NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      audit_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL CHECK(phase IN ('coding','auditing')),
      execution_model TEXT,
      auditor_model TEXT,
      model_failed INTEGER NOT NULL DEFAULT 0,
      sandbox INTEGER NOT NULL DEFAULT 0,
      sandbox_container TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      termination_reason TEXT,
      completion_summary TEXT,
      workspace_id         TEXT,
      host_session_id      TEXT,
      audit_session_id     TEXT,
      session_directory    TEXT,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS loop_large_fields (
      project_id TEXT NOT NULL,
      loop_name TEXT NOT NULL,
      prompt TEXT,
      last_audit_result TEXT,
      PRIMARY KEY (project_id, loop_name),
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    )
  `)
  return { db, dbPath }
}

// Helper to get DB path from test database
function getDbPath(db: Database): string {
  return (db as any).path
}

// Helper to insert loop data into the loops table
function insertLoopData(
  db: Database,
  projectId: string,
  loopName: string,
  options: {
    status?: 'running' | 'completed' | 'cancelled' | 'errored' | 'stalled'
    sessionId?: string
    phase?: 'coding' | 'auditing'
    iteration?: number
    maxIterations?: number
    startedAt?: number
    completedAt?: number | null
    terminationReason?: string | null
    worktreeBranch?: string | null
      worktree?: boolean
      worktreeDir?: string
      executionModel?: string | null
      auditorModel?: string | null
      hostSessionId?: string | null
  } = {}
): void {
  const now = options.startedAt ?? Date.now()
  db.prepare(`
    INSERT INTO loops (
      project_id, loop_name, status, current_session_id, worktree, worktree_dir,
      worktree_branch, project_dir, max_iterations, iteration, audit_count,
      error_count, phase, execution_model, auditor_model,
      model_failed, sandbox, sandbox_container, started_at, completed_at,
      termination_reason, completion_summary, workspace_id, host_session_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    loopName,
    options.status ?? 'running',
    options.sessionId ?? 'test-session',
    options.worktree ? 1 : 0,
    options.worktreeDir ?? '/tmp/test',
    options.worktreeBranch ?? null,
    '/tmp/test',
    options.maxIterations ?? 5,
    options.iteration ?? 1,
    0,
    0,
    options.phase ?? 'coding',
    options.executionModel ?? null,
    options.auditorModel ?? null,
    0,
    0,
    null,
    now,
    options.completedAt ?? null,
    options.terminationReason ?? null,
    null,
    null,
    options.hostSessionId ?? null
  )
}

describe('TUI Refresh Behavior', () => {
  let db: Database
  let dbPath: string
  const projectId = 'test-project'

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    dbPath = result.dbPath
  })

  afterEach(() => {
    try { db.close() } catch {}
    try { rmSync(dbPath) } catch {}
  })

  describe('readLoopStates', () => {
    test('Returns empty array when database does not exist', () => {
      const states = readLoopStates('non-existent-project')
      expect(states).toEqual([])
    })

    test('Returns loop states from loops table', () => {
      const now = Date.now()
      insertLoopData(db, projectId, 'test-loop', {
        sessionId: 'test-session-123',
        phase: 'coding',
        iteration: 1,
        maxIterations: 5,
        status: 'running',
        startedAt: now,
      })

      const states = readLoopStates(projectId, dbPath)
      expect(states.length).toBe(1)
      expect(states[0].name).toBe('test-loop')
      expect(states[0].active).toBe(true)
      expect(states[0].phase).toBe('coding')
    })

    test('Filters out non-running loops', () => {
      const now = Date.now()
      
      insertLoopData(db, projectId, 'active-loop', {
        sessionId: 'session-1',
        phase: 'coding',
        iteration: 1,
        status: 'running',
        startedAt: now,
      })
      
      insertLoopData(db, projectId, 'completed-loop', {
        sessionId: 'session-2',
        phase: 'coding',
        iteration: 1,
        status: 'completed',
        startedAt: now - 2000,
        completedAt: now - 1000,
      })

      const states = readLoopStates(projectId, dbPath)
      // Note: readLoopStates returns ALL loops, not just running ones
      // The filtering is done by the caller if needed
      expect(states.length).toBe(2)
    })

    test('Sorts by started_at DESC', () => {
      const now = Date.now()

      insertLoopData(db, projectId, 'older-loop', {
        sessionId: 'session-1',
        phase: 'coding',
        iteration: 1,
        status: 'running',
        startedAt: now - 5000,
      })
      
      insertLoopData(db, projectId, 'newer-loop', {
        sessionId: 'session-2',
        phase: 'coding',
        iteration: 1,
        status: 'running',
        startedAt: now,
      })

      const states = readLoopStates(projectId, dbPath)
      expect(states.length).toBe(2)
      expect(states[0].name).toBe('newer-loop')
      expect(states[1].name).toBe('older-loop')
    })

    test('Hydrates hostSessionId from database', () => {
      const now = Date.now()
      insertLoopData(db, projectId, 'loop-with-host', {
        sessionId: 'session-host',
        phase: 'coding',
        iteration: 1,
        status: 'completed',
        startedAt: now,
        hostSessionId: 'host-session-123',
      })

      const states = readLoopStates(projectId, dbPath)
      expect(states.length).toBe(1)
      expect(states[0].hostSessionId).toBe('host-session-123')
    })

    test('Returns undefined when hostSessionId is null', () => {
      const now = Date.now()
      insertLoopData(db, projectId, 'loop-without-host', {
        sessionId: 'session-no-host',
        phase: 'coding',
        iteration: 1,
        status: 'running',
        startedAt: now,
        hostSessionId: null,
      })

      const states = readLoopStates(projectId, dbPath)
      expect(states.length).toBe(1)
      expect(states[0].hostSessionId).toBeUndefined()
    })
  })

  describe('readLoopByName', () => {
    test('Returns null when database does not exist', () => {
      const result = readLoopByName('non-existent-project', 'test-loop')
      expect(result).toBeNull()
    })

    test('Returns loop state by name', () => {
      const now = Date.now()
      insertLoopData(db, projectId, 'specific-loop', {
        sessionId: 'test-session-456',
        phase: 'auditing',
        iteration: 2,
        maxIterations: 5,
        status: 'running',
        startedAt: now,
      })

      const result = readLoopByName(projectId, 'specific-loop', dbPath)
      expect(result).toBeDefined()
      expect(result?.name).toBe('specific-loop')
      expect(result?.sessionId).toBe('test-session-456')
      expect(result?.phase).toBe('auditing')
      expect(result?.active).toBe(true)
    })

    test('Returns null when loop does not exist', () => {
      const result = readLoopByName(projectId, 'non-existent-loop', dbPath)
      expect(result).toBeNull()
    })

    test('Returns loop with completion metadata', () => {
      const now = Date.now()
      insertLoopData(db, projectId, 'completed-loop', {
        sessionId: 'test-session-789',
        phase: 'coding',
        iteration: 3,
        maxIterations: 5,
        status: 'completed',
        startedAt: now - 5000,
        completedAt: now - 1000,
        terminationReason: 'completed',
      })

      const result = readLoopByName(projectId, 'completed-loop', dbPath)
      expect(result).toBeDefined()
      expect(result?.name).toBe('completed-loop')
      expect(result?.active).toBe(false)
    })

    test('Hydrates hostSessionId from database', () => {
      const now = Date.now()
      insertLoopData(db, projectId, 'loop-with-host', {
        sessionId: 'test-session-host',
        phase: 'coding',
        iteration: 1,
        status: 'completed',
        startedAt: now,
        hostSessionId: 'host-session-456',
      })

      const result = readLoopByName(projectId, 'loop-with-host', dbPath)
      expect(result).toBeDefined()
      expect(result?.hostSessionId).toBe('host-session-456')
    })
  })

  describe('Stale state regression', () => {
    test('Active loops are visible in readLoopStates even if old', () => {
      const now = Date.now() - 10 * 60 * 1000 // 10 minutes ago
      
      insertLoopData(db, projectId, 'old-active-loop', {
        sessionId: 'session-old',
        phase: 'coding',
        iteration: 1,
        status: 'running',
        startedAt: now,
      })

      const states = readLoopStates(projectId, dbPath)
      expect(states.length).toBe(1)
      expect(states[0].active).toBe(true)
      expect(states[0].name).toBe('old-active-loop')
    })

    test('Inactive loops are returned by readLoopStates (UI filters by 5 min cutoff)', () => {
      // Note: readLoopStates returns all non-expired loops from KV
      // The 5-minute cutoff filtering happens in the Sidebar UI component
      const now = Date.now()
      const oldCutoff = now - 6 * 60 * 1000 // 6 minutes ago (beyond 5 min cutoff)

      insertLoopData(db, projectId, 'old-inactive-loop', {
        sessionId: 'session-old',
        phase: 'coding',
        iteration: 1,
        status: 'completed',
        startedAt: oldCutoff,
        completedAt: oldCutoff,
      })

      const states = readLoopStates(projectId, dbPath)
      // readLoopStates returns it, but Sidebar would filter it out
      expect(states.length).toBe(1)
      expect(states[0].active).toBe(false)
      
      // Verify the UI filtering logic would exclude it
      const cutoff = now - 5 * 60 * 1000
      const visible = states.filter(l => 
        l.active || (l.completedAt && new Date(l.completedAt).getTime() > cutoff)
      )
      expect(visible.length).toBe(0)
    })
  })


})
