import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { createPlansRepo, type PlanRow } from '../src/storage'

const TEST_DIR = '/tmp/opencode-plans-repo-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS plans (
      project_id   TEXT NOT NULL,
      loop_name    TEXT,
      session_id   TEXT,
      content      TEXT NOT NULL,
      updated_at   INTEGER NOT NULL,
      CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
      CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
      UNIQUE (project_id, loop_name),
      UNIQUE (project_id, session_id)
    )
  `)
  return db
}

describe('PlansRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createPlansRepo>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    repo = createPlansRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('writeForSession', () => {
    test('writes plan for session', () => {
      const sessionId = 'session-123'
      const content = 'Test plan content'
      const now = Date.now()

      repo.writeForSession(projectId, sessionId, content)

      const row = repo.getForSession(projectId, sessionId)
      expect(row).toBeDefined()
      expect(row?.sessionId).toBe(sessionId)
      expect(row?.content).toBe(content)
      expect(row?.loopName).toBeNull()
      expect(row?.updatedAt).toBeGreaterThan(now - 1000)
    })

    test('overwrites existing session plan', () => {
      const sessionId = 'session-123'
      repo.writeForSession(projectId, sessionId, 'First content')
      repo.writeForSession(projectId, sessionId, 'Second content')

      const row = repo.getForSession(projectId, sessionId)
      expect(row?.content).toBe('Second content')
    })
  })

  describe('writeForLoop', () => {
    test('writes plan for loop', () => {
      const loopName = 'test-loop'
      const content = 'Test plan content'
      const now = Date.now()

      repo.writeForLoop(projectId, loopName, content)

      const row = repo.getForLoop(projectId, loopName)
      expect(row).toBeDefined()
      expect(row?.loopName).toBe(loopName)
      expect(row?.content).toBe(content)
      expect(row?.sessionId).toBeNull()
      expect(row?.updatedAt).toBeGreaterThan(now - 1000)
    })

    test('overwrites existing loop plan', () => {
      const loopName = 'test-loop'
      repo.writeForLoop(projectId, loopName, 'First content')
      repo.writeForLoop(projectId, loopName, 'Second content')

      const row = repo.getForLoop(projectId, loopName)
      expect(row?.content).toBe('Second content')
    })
  })

  describe('getForSession', () => {
    test('returns null for non-existent session', () => {
      const row = repo.getForSession(projectId, 'non-existent')
      expect(row).toBeNull()
    })

    test('returns plan for existing session', () => {
      const sessionId = 'session-123'
      const content = 'Test content'
      repo.writeForSession(projectId, sessionId, content)

      const row = repo.getForSession(projectId, sessionId)
      expect(row?.content).toBe(content)
    })
  })

  describe('getForLoop', () => {
    test('returns null for non-existent loop', () => {
      const row = repo.getForLoop(projectId, 'non-existent')
      expect(row).toBeNull()
    })

    test('returns plan for existing loop', () => {
      const loopName = 'test-loop'
      const content = 'Test content'
      repo.writeForLoop(projectId, loopName, content)

      const row = repo.getForLoop(projectId, loopName)
      expect(row?.content).toBe(content)
    })
  })

  describe('getForLoopOrSession', () => {
    test('prefers loop over session', () => {
      const loopName = 'test-loop'
      const sessionId = 'session-123'
      repo.writeForLoop(projectId, loopName, 'Loop content')
      repo.writeForSession(projectId, sessionId, 'Session content')

      const row = repo.getForLoopOrSession(projectId, loopName, sessionId)
      expect(row?.content).toBe('Loop content')
      expect(row?.loopName).toBe(loopName)
    })

    test('falls back to session when no loop', () => {
      const sessionId = 'session-123'
      repo.writeForSession(projectId, sessionId, 'Session content')

      const row = repo.getForLoopOrSession(projectId, 'non-existent', sessionId)
      expect(row?.content).toBe('Session content')
      expect(row?.sessionId).toBe(sessionId)
    })

    test('returns null when neither exists', () => {
      const row = repo.getForLoopOrSession(projectId, 'no-loop', 'no-session')
      expect(row).toBeNull()
    })
  })

  describe('promote', () => {
    test('promotes session plan to loop plan', () => {
      const sessionId = 'session-123'
      const loopName = 'test-loop'
      const content = 'Test content'
      repo.writeForSession(projectId, sessionId, content)

      const result = repo.promote(projectId, sessionId, loopName)
      expect(result).toBe(true)

      // Session key should return null
      const sessionRow = repo.getForSession(projectId, sessionId)
      expect(sessionRow).toBeNull()

      // Loop key should have the content
      const loopRow = repo.getForLoop(projectId, loopName)
      expect(loopRow).toBeDefined()
      expect(loopRow?.content).toBe(content)
      expect(loopRow?.loopName).toBe(loopName)
      expect(loopRow?.sessionId).toBeNull()
    })

    test('returns false when no session plan exists', () => {
      const result = repo.promote(projectId, 'non-existent', 'test-loop')
      expect(result).toBe(false)
    })

    test('preserves content during promotion', () => {
      const sessionId = 'session-123'
      const loopName = 'test-loop'
      const content = 'Preserved content'
      repo.writeForSession(projectId, sessionId, content)

      repo.promote(projectId, sessionId, loopName)

      const loopRow = repo.getForLoop(projectId, loopName)
      expect(loopRow?.content).toBe(content)
    })
  })

  describe('deleteForSession', () => {
    test('deletes session plan', () => {
      const sessionId = 'session-123'
      repo.writeForSession(projectId, sessionId, 'Content')
      repo.deleteForSession(projectId, sessionId)

      const row = repo.getForSession(projectId, sessionId)
      expect(row).toBeNull()
    })

    test('does not error on non-existent session', () => {
      expect(() => repo.deleteForSession(projectId, 'non-existent')).not.toThrow()
    })
  })

  describe('deleteForLoop', () => {
    test('deletes loop plan', () => {
      const loopName = 'test-loop'
      repo.writeForLoop(projectId, loopName, 'Content')
      repo.deleteForLoop(projectId, loopName)

      const row = repo.getForLoop(projectId, loopName)
      expect(row).toBeNull()
    })

    test('does not error on non-existent loop', () => {
      expect(() => repo.deleteForLoop(projectId, 'non-existent')).not.toThrow()
    })
  })

  describe('constraint enforcement', () => {
    test('allows loop_name XOR session_id (not both)', () => {
      // This should work - only loop_name
      expect(() => repo.writeForLoop(projectId, 'loop', 'content')).not.toThrow()

      // This should work - only session_id
      expect(() => repo.writeForSession(projectId, 'session', 'content')).not.toThrow()
    })
  })

  describe('listRecent', () => {
    test('lists project plans newest first and excludes other projects', () => {
      const otherProject = 'other-project'
      const t1 = 1000000
      const t2 = 2000000
      const t3 = 3000000

      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'loop-older', 'Older plan content', t1]
      )
      db.run(
        "INSERT INTO plans (project_id, session_id, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'session-newer', 'Newer plan content', t2]
      )
      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [otherProject, 'other-loop', 'Other project plan', t3]
      )

      const rows = repo.listRecent(projectId, { limit: 10 })

      expect(rows).toHaveLength(2)
      expect(rows[0].updatedAt).toBe(t2)
      expect(rows[0].sessionId).toBe('session-newer')
      expect(rows[0].loopName).toBeNull()
      expect(rows[0].content).toBe('Newer plan content')
      expect(rows[0].projectId).toBe(projectId)

      expect(rows[1].updatedAt).toBe(t1)
      expect(rows[1].loopName).toBe('loop-older')
      expect(rows[1].sessionId).toBeNull()
      expect(rows[1].content).toBe('Older plan content')

      expect(rows.every((r) => r.projectId === projectId)).toBe(true)
    })

    test('limits recent project plans', () => {
      const t1 = 1000000
      const t2 = 2000000
      const t3 = 3000000

      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'oldest-loop', 'Oldest', t1]
      )
      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'middle-loop', 'Middle', t2]
      )
      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'newest-loop', 'Newest', t3]
      )

      const rows = repo.listRecent(projectId, { limit: 2 })
      expect(rows).toHaveLength(2)
      expect(rows[0].loopName).toBe('newest-loop')
      expect(rows[1].loopName).toBe('middle-loop')
    })

    test('uses default limit of 20 when not specified', () => {
      const bigProject = 'big-project'
      for (let i = 0; i < 25; i++) {
        db.run(
          "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
          [bigProject, `loop-${i}`, `Plan ${i}`, 1000000 + i * 1000]
        )
      }

      const rows = repo.listRecent(bigProject)
      expect(rows).toHaveLength(20)
      expect(rows[0].updatedAt).toBeGreaterThan(rows[rows.length - 1].updatedAt)
    })
  })

  describe('searchRecent', () => {
    test('searches recent project plans by regex', () => {
      const otherProject = 'other-project'
      const t1 = 1000000
      const t2 = 2000000
      const t3 = 3000000
      const t4 = 4000000

      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'auth-loop', 'Implementation of auth module', t1]
      )
      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'ui-loop', 'UI redesign for dashboard', t2]
      )
      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'login-loop', 'Login page improvements', t3]
      )
      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [otherProject, 'other-auth-loop', 'Auth for other project', t4]
      )

      const rows = repo.searchRecent(projectId, /auth|login/i, { limit: 10 })

      expect(rows).toHaveLength(2)
      expect(rows[0].loopName).toBe('login-loop')
      expect(rows[0].updatedAt).toBe(t3)
      expect(rows[1].loopName).toBe('auth-loop')
      expect(rows[1].updatedAt).toBe(t1)

      expect(rows.every((r) => r.projectId === projectId)).toBe(true)
    })

    test('limits search results', () => {
      const t1 = 1000000
      const t2 = 2000000
      const t3 = 3000000

      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'loop-auth-a', 'Auth module A', t1]
      )
      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'loop-auth-b', 'Auth module B', t2]
      )
      db.run(
        "INSERT INTO plans (project_id, loop_name, content, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, 'loop-auth-c', 'Auth module C', t3]
      )

      const rows = repo.searchRecent(projectId, /auth/i, { limit: 2 })
      expect(rows).toHaveLength(2)
      expect(rows[0].updatedAt).toBe(t3)
      expect(rows[1].updatedAt).toBe(t2)
    })
  })
})
