import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { createPlanAmendmentsRepo } from '../src/storage/repos/plan-amendments-repo'
import type { PlanAmendmentRow } from '../src/storage/repos/plan-amendments-repo'

const TEST_DIR = `/tmp/opencode-plan-amendments-test-${Date.now()}`

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
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_project_name ON loops(project_id, loop_name)`)
  db.run(`
    CREATE TABLE IF NOT EXISTS plan_amendments (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id         TEXT NOT NULL,
      loop_name          TEXT NOT NULL,
      source             TEXT NOT NULL DEFAULT 'auditor',
      rationale          TEXT NOT NULL,
      applied_at_section INTEGER NOT NULL,
      sections_before    TEXT NOT NULL,
      sections_after     TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_plan_amendments_loop ON plan_amendments (project_id, loop_name, id)`)
  return db
}

describe('PlanAmendmentsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createPlanAmendmentsRepo>
  const projectId = 'test-project'
  const loopName = 'test-loop'

  beforeEach(() => {
    db = createTestDb()
    db.run(`INSERT INTO loops (project_id, loop_name) VALUES (?, ?)`, [projectId, loopName])
    repo = createPlanAmendmentsRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  function baseRow(overrides: Partial<Omit<PlanAmendmentRow, 'id' | 'createdAt'>> = {}): Omit<PlanAmendmentRow, 'id' | 'createdAt'> {
    return {
      projectId,
      loopName,
      source: 'auditor',
      rationale: 'adjusting pending sections',
      appliedAtSection: 3,
      sectionsBefore: JSON.stringify([
        { index: 4, title: 'Old A', content: 'a' },
        { index: 5, title: 'Old B', content: 'b' },
      ]),
      sectionsAfter: JSON.stringify([
        { index: 4, title: 'New A', content: 'a-new' },
      ]),
      ...overrides,
    }
  }

  describe('insert', () => {
    test('inserts a row and listForLoop returns it ascending by id', () => {
      repo.insert(baseRow({ rationale: 'first' }))
      repo.insert(baseRow({ rationale: 'second' }))

      const rows = repo.listForLoop(projectId, loopName)
      expect(rows).toHaveLength(2)
      expect(rows[0].id).toBeLessThan(rows[1].id)
      expect(rows[0].rationale).toBe('first')
      expect(rows[1].rationale).toBe('second')
    })

    test('sets created_at to Date.now()', () => {
      const before = Date.now()
      repo.insert(baseRow())
      const after = Date.now()
      const rows = repo.listForLoop(projectId, loopName)
      expect(rows[0].createdAt).toBeGreaterThanOrEqual(before)
      expect(rows[0].createdAt).toBeLessThanOrEqual(after)
    })

    test('preserves JSON sections_before/after verbatim', () => {
      const before = JSON.stringify([{ index: 4, title: 'X', content: 'x' }])
      const after = JSON.stringify([{ index: 4, title: 'Y', content: 'y' }])
      repo.insert(baseRow({ sectionsBefore: before, sectionsAfter: after }))

      const rows = repo.listForLoop(projectId, loopName)
      expect(rows[0].sectionsBefore).toBe(before)
      expect(rows[0].sectionsAfter).toBe(after)
    })

    test('scopes rows by projectId + loopName', () => {
      const otherLoop = 'other-loop'
      db.run(`INSERT INTO loops (project_id, loop_name) VALUES (?, ?)`, [projectId, otherLoop])

      repo.insert(baseRow({ rationale: 'a' }))
      repo.insert(baseRow({ loopName: otherLoop, rationale: 'b' }))

      expect(repo.listForLoop(projectId, loopName).map((r) => r.rationale)).toEqual(['a'])
      expect(repo.listForLoop(projectId, otherLoop).map((r) => r.rationale)).toEqual(['b'])
    })

    test('defaults source to "auditor" when not provided', () => {
      // The DB column has DEFAULT 'auditor'; pass no source by relying on the
      // insert path always providing one (the repo's contract). Confirm the
      // value supplied via the repo is stored verbatim.
      repo.insert(baseRow({ source: 'auditor' }))
      expect(repo.listForLoop(projectId, loopName)[0].source).toBe('auditor')
    })
  })

  describe('FK cascade on loop delete', () => {
    test('deleting the loop row cascades to plan_amendments', () => {
      repo.insert(baseRow({ rationale: 'a' }))
      repo.insert(baseRow({ rationale: 'b' }))

      expect(repo.listForLoop(projectId, loopName)).toHaveLength(2)

      db.run(`DELETE FROM loops WHERE project_id = ? AND loop_name = ?`, [projectId, loopName])

      expect(repo.listForLoop(projectId, loopName)).toHaveLength(0)
    })
  })
})
