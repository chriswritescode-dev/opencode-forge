import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { createLoopTransitionsRepo } from '../src/storage/repos/loop-transitions-repo'
import type { LoopTransitionRow } from '../src/storage/repos/loop-transitions-repo'

const TEST_DIR = `/tmp/opencode-loop-transitions-test-${Date.now()}`

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run('PRAGMA foreign_keys = ON')
  db.run(`
    CREATE TABLE loops (
      project_id TEXT NOT NULL,
      loop_name  TEXT NOT NULL,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  // The unique index on (project_id, loop_name) is required by SQLite for the
  // composite foreign key from loop_transitions to support ON DELETE CASCADE.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_project_name ON loops(project_id, loop_name)`)
  db.run(`
    CREATE TABLE IF NOT EXISTS loop_transitions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      TEXT NOT NULL,
      loop_name       TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      transition_kind TEXT NOT NULL,
      from_phase      TEXT NOT NULL,
      to_phase        TEXT,
      status          TEXT,
      reason          TEXT,
      iteration       INTEGER NOT NULL DEFAULT 0,
      section_index   INTEGER,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_loop_transitions_loop ON loop_transitions (project_id, loop_name, id)`)
  return db
}

describe('LoopTransitionsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createLoopTransitionsRepo>
  const projectId = 'test-project'
  const loopName = 'test-loop'

  beforeEach(() => {
    db = createTestDb()
    db.run(`INSERT INTO loops (project_id, loop_name) VALUES (?, ?)`, [projectId, loopName])
    repo = createLoopTransitionsRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  function baseRow(overrides: Partial<Omit<LoopTransitionRow, 'id' | 'createdAt'>> = {}): Omit<LoopTransitionRow, 'id' | 'createdAt'> {
    return {
      projectId,
      loopName,
      eventType: 'audit-clear',
      transitionKind: 'terminate',
      fromPhase: 'auditing',
      toPhase: null,
      status: 'completed',
      reason: 'completed',
      iteration: 1,
      sectionIndex: null,
      ...overrides,
    }
  }

  describe('insert', () => {
    test('inserts a row and listForLoop returns it ascending by id', () => {
      repo.insert(baseRow({ eventType: 'section-clean', transitionKind: 'advance-section', fromPhase: 'auditing', toPhase: 'coding', iteration: 1, sectionIndex: 0 }))
      repo.insert(baseRow({ eventType: 'section-clean', transitionKind: 'advance-section', fromPhase: 'auditing', toPhase: 'coding', iteration: 2, sectionIndex: 1 }))

      const rows = repo.listForLoop(projectId, loopName)
      expect(rows).toHaveLength(2)
      expect(rows[0].id).toBeLessThan(rows[1].id)
      expect(rows[0].iteration).toBe(1)
      expect(rows[1].iteration).toBe(2)
    })

    test('sets created_at to Date.now()', () => {
      const before = Date.now()
      repo.insert(baseRow())
      const after = Date.now()
      const rows = repo.listForLoop(projectId, loopName)
      expect(rows[0].createdAt).toBeGreaterThanOrEqual(before)
      expect(rows[0].createdAt).toBeLessThanOrEqual(after)
    })

    test('preserves null status/reason/section_index/to_phase', () => {
      repo.insert(baseRow({ status: null, reason: null, sectionIndex: null, toPhase: null }))
      const rows = repo.listForLoop(projectId, loopName)
      expect(rows[0].status).toBeNull()
      expect(rows[0].reason).toBeNull()
      expect(rows[0].sectionIndex).toBeNull()
      expect(rows[0].toPhase).toBeNull()
    })

    test('scopes rows by projectId + loopName', () => {
      const otherLoop = 'other-loop'
      db.run(`INSERT INTO loops (project_id, loop_name) VALUES (?, ?)`, [projectId, otherLoop])

      repo.insert(baseRow({ eventType: 'a' }))
      repo.insert(baseRow({ loopName: otherLoop, eventType: 'b' }))

      expect(repo.listForLoop(projectId, loopName).map(r => r.eventType)).toEqual(['a'])
      expect(repo.listForLoop(projectId, otherLoop).map(r => r.eventType)).toEqual(['b'])
    })
  })

  describe('listForLoop ordering', () => {
    test('returns rows in ascending id order', () => {
      for (let i = 0; i < 5; i++) {
        repo.insert(baseRow({ iteration: i }))
      }
      const rows = repo.listForLoop(projectId, loopName)
      expect(rows.map(r => r.id)).toEqual([...rows].sort((a, b) => a.id - b.id).map(r => r.id))
      expect(rows.map(r => r.iteration)).toEqual([0, 1, 2, 3, 4])
    })

    test('respects the limit argument by keeping the newest rows in ascending order', () => {
      for (let i = 0; i < 10; i++) {
        repo.insert(baseRow({ iteration: i }))
      }
      const limited = repo.listForLoop(projectId, loopName, 3)
      expect(limited).toHaveLength(3)
      // Newest-3 retained (iterations 7,8,9), returned oldest-to-newest.
      expect(limited.map(r => r.iteration)).toEqual([7, 8, 9])
    })

    test('for 101+ rows, listForLoop keeps the newest 100 and omits the oldest overflow', () => {
      for (let i = 0; i < 120; i++) {
        repo.insert(baseRow({ iteration: i }))
      }
      const rows = repo.listForLoop(projectId, loopName, 100)
      expect(rows).toHaveLength(100)
      // Newest 100 = iterations 20..119, ascending.
      expect(rows[0].iteration).toBe(20)
      expect(rows[99].iteration).toBe(119)
      // Oldest overflow row (iteration 0) is omitted entirely.
      expect(rows.map(r => r.iteration)).not.toContain(0)
    })

    test('uses a sensible default limit when omitted', () => {
      for (let i = 0; i < 5; i++) {
        repo.insert(baseRow({ iteration: i }))
      }
      expect(repo.listForLoop(projectId, loopName)).toHaveLength(5)
    })
  })

  describe('FK cascade on loop delete', () => {
    test('deleting the loop row cascades to loop_transitions', () => {
      repo.insert(baseRow({ eventType: 'a', iteration: 0 }))
      repo.insert(baseRow({ eventType: 'b', iteration: 1 }))

      expect(repo.listForLoop(projectId, loopName)).toHaveLength(2)

      db.run(`DELETE FROM loops WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])

      expect(repo.listForLoop(projectId, loopName)).toHaveLength(0)
    })
  })
})
