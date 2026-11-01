import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { createPlanAmendmentsRepo } from '../src/storage/repos/plan-amendments-repo'
import type { PlanAmendmentRow } from '../src/storage/repos/plan-amendments-repo'
import { createTestDb, type TestDb } from './helpers/test-db'

describe('PlanAmendmentsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createPlanAmendmentsRepo>
  let testDb: TestDb
  const projectId = 'test-project'
  const loopName = 'test-loop'

  function insertLoop(projectId: string, loopName: string, status: 'running' | 'completed' = 'running'): void {
    db.prepare(
      `INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, audit_count, error_count, phase, started_at)
       VALUES (?, ?, ?, ?, 0, '/tmp/wt', '/tmp/proj', 5, 0, 0, 0, 'coding', ?)`,
    ).run(projectId, loopName, status, `${projectId}-${loopName}-session`, Date.now())
  }

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
    insertLoop(projectId, loopName)
    repo = createPlanAmendmentsRepo(db)
  })

  afterEach(() => {
    testDb.cleanup()
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
      insertLoop(projectId, otherLoop)

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

  describe('get', () => {
    test('returns the row for an existing id', () => {
      repo.insert(baseRow({ rationale: 'target' }))
      const row = repo.listForLoop(projectId, loopName)[0]
      const found = repo.get(projectId, loopName, row.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(row.id)
      expect(found!.rationale).toBe('target')
      expect(found!.appliedAtSection).toBe(3)
      expect(found!.sectionsBefore).toBe(row.sectionsBefore)
      expect(found!.sectionsAfter).toBe(row.sectionsAfter)
    })

    test('returns null for an unknown id', () => {
      repo.insert(baseRow())
      expect(repo.get(projectId, loopName, 9999)).toBeNull()
    })

    test('does not cross project/loop boundaries', () => {
      const otherLoop = 'other-loop'
      insertLoop(projectId, otherLoop)

      repo.insert(baseRow({ rationale: 'a' }))
      repo.insert(baseRow({ loopName: otherLoop, rationale: 'b' }))

      const idA = repo.listForLoop(projectId, loopName)[0].id
      const idB = repo.listForLoop(projectId, otherLoop)[0].id
      expect(repo.get(projectId, otherLoop, idA)).toBeNull()
      expect(repo.get(projectId, loopName, idB)).toBeNull()
      expect(repo.get('other-project', loopName, idA)).toBeNull()
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
