import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createSectionPlansRepo } from '../src/storage/repos/section-plans-repo'
import type { ParsedSection } from '../src/utils/section-capture'

const TEST_DIR = `/tmp/opencode-section-plans-test-${Date.now()}`

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS loops (
      project_id TEXT NOT NULL,
      loop_name  TEXT NOT NULL,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS section_plans (
      project_id    TEXT    NOT NULL,
      loop_name     TEXT    NOT NULL,
      section_index INTEGER NOT NULL,
      title         TEXT    NOT NULL,
      content       TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','in_progress','completed','failed')),
      attempts      INTEGER NOT NULL DEFAULT 0,
      summary_done           TEXT,
      summary_deviations     TEXT,
      summary_follow_ups     TEXT,
      started_at    INTEGER,
      completed_at  INTEGER,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (project_id, loop_name, section_index),
      FOREIGN KEY (project_id, loop_name)
        REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_section_plans_status ON section_plans(project_id, loop_name, status)`)
  return db
}

describe('SectionPlansRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createSectionPlansRepo>
  const projectId = 'test-project'
  const loopName = 'test-loop'

  beforeEach(() => {
    db = createTestDb()
    // Insert a parent loop row to satisfy FK constraint
    db.run(`INSERT INTO loops (project_id, loop_name) VALUES (?, ?)`, [projectId, loopName])
    repo = createSectionPlansRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('bulkInsert', () => {
    test('inserts multiple sections', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'Section Zero', content: 'Content zero' },
        { index: 1, title: 'Section One', content: 'Content one' },
        { index: 2, title: 'Section Two', content: 'Content two' },
      ]

      const result = repo.bulkInsert({ projectId, loopName, sections })
      expect(result.inserted).toBe(3)

      const list = repo.list(projectId, loopName)
      expect(list).toHaveLength(3)
      expect(list[0].title).toBe('Section Zero')
      expect(list[1].title).toBe('Section One')
      expect(list[2].title).toBe('Section Two')
    })

    test('ignores duplicate inserts (INSERT OR IGNORE)', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'First', content: 'First content' },
        { index: 1, title: 'Second', content: 'Second content' },
      ]

      repo.bulkInsert({ projectId, loopName, sections })
      const result = repo.bulkInsert({ projectId, loopName, sections })
      expect(result.inserted).toBe(0)
      expect(repo.count(projectId, loopName)).toBe(2)
    })

    test('sets default status to pending', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'Zero', content: 'Content' },
      ]

      repo.bulkInsert({ projectId, loopName, sections })
      const row = repo.get(projectId, loopName, 0)
      expect(row?.status).toBe('pending')
      expect(row?.attempts).toBe(0)
    })

    test('inserts into different projects independently', () => {
      const otherProject = 'other-project'
      db.run(`INSERT INTO loops (project_id, loop_name) VALUES (?, ?)`, [otherProject, loopName])

      const sections: ParsedSection[] = [
        { index: 0, title: 'Original', content: 'Original content' },
      ]
      const otherSections: ParsedSection[] = [
        { index: 0, title: 'Other', content: 'Other content' },
      ]

      repo.bulkInsert({ projectId, loopName, sections })
      repo.bulkInsert({ projectId: otherProject, loopName, sections: otherSections })

      expect(repo.count(projectId, loopName)).toBe(1)
      expect(repo.count(otherProject, loopName)).toBe(1)
      expect(repo.get(otherProject, loopName, 0)?.title).toBe('Other')
    })
  })

  describe('get', () => {
    test('returns null for non-existent section', () => {
      expect(repo.get(projectId, loopName, 999)).toBeNull()
    })

    test('returns the correct section by index', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'Zero', content: 'Zero content' },
        { index: 1, title: 'One', content: 'One content' },
      ]
      repo.bulkInsert({ projectId, loopName, sections })

      const row = repo.get(projectId, loopName, 1)
      expect(row).not.toBeNull()
      expect(row?.sectionIndex).toBe(1)
      expect(row?.title).toBe('One')
      expect(row?.content).toBe('One content')
    })

    test('maps all fields correctly', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'Test', content: 'Body' },
      ]
      repo.bulkInsert({ projectId, loopName, sections })

      const row = repo.get(projectId, loopName, 0)
      expect(row).toMatchObject({
        projectId,
        loopName,
        sectionIndex: 0,
        title: 'Test',
        content: 'Body',
        status: 'pending',
        attempts: 0,
        summaryDone: null,
        summaryDeviations: null,
        summaryFollowUps: null,
        startedAt: null,
        completedAt: null,
      })
      expect(row?.createdAt).toBeGreaterThan(0)
    })
  })

  describe('listCompleted', () => {
    test('returns empty when no sections are completed', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'A', content: 'A content' },
        { index: 1, title: 'B', content: 'B content' },
      ]
      repo.bulkInsert({ projectId, loopName, sections })

      const completed = repo.listCompleted(projectId, loopName)
      expect(completed).toHaveLength(0)
    })

    test('returns only completed sections', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'A', content: 'A content' },
        { index: 1, title: 'B', content: 'B content' },
        { index: 2, title: 'C', content: 'C content' },
      ]
      repo.bulkInsert({ projectId, loopName, sections })

      repo.setStatus(projectId, loopName, 0, 'completed')
      repo.setStatus(projectId, loopName, 2, 'completed')

      const completed = repo.listCompleted(projectId, loopName)
      expect(completed).toHaveLength(2)
      expect(completed[0].sectionIndex).toBe(0)
      expect(completed[1].sectionIndex).toBe(2)
    })
  })

  describe('setStatus', () => {
    test('updates status to in_progress', () => {
      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })

      repo.setStatus(projectId, loopName, 0, 'in_progress')
      expect(repo.get(projectId, loopName, 0)?.status).toBe('in_progress')
    })

    test('updates status to completed', () => {
      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })

      repo.setStatus(projectId, loopName, 0, 'completed')
      expect(repo.get(projectId, loopName, 0)?.status).toBe('completed')
    })

    test('updates status to failed', () => {
      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })

      repo.setStatus(projectId, loopName, 0, 'failed')
      expect(repo.get(projectId, loopName, 0)?.status).toBe('failed')
    })
  })

  describe('setSummary', () => {
    test('sets summary parts individually', () => {
      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })

      repo.setSummary(projectId, loopName, 0, { done: 'Task done' })
      const row = repo.get(projectId, loopName, 0)
      expect(row?.summaryDone).toBe('Task done')
      expect(row?.summaryDeviations).toBeNull()
      expect(row?.summaryFollowUps).toBeNull()
    })

    test('sets all summary parts at once', () => {
      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })

      repo.setSummary(projectId, loopName, 0, {
        done: 'Done',
        deviations: 'Deviated',
        followUps: 'Follow ups',
      })
      const row = repo.get(projectId, loopName, 0)
      expect(row?.summaryDone).toBe('Done')
      expect(row?.summaryDeviations).toBe('Deviated')
      expect(row?.summaryFollowUps).toBe('Follow ups')
    })

    test('does not overwrite existing values when not provided', () => {
      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })

      repo.setSummary(projectId, loopName, 0, { done: 'First' })
      repo.setSummary(projectId, loopName, 0, { deviations: 'Second' })

      const row = repo.get(projectId, loopName, 0)
      expect(row?.summaryDone).toBe('First')
      expect(row?.summaryDeviations).toBe('Second')
      expect(row?.summaryFollowUps).toBeNull()
    })
  })

  describe('setStartedAt', () => {
    test('sets the started timestamp', () => {
      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })

      const ms = 1700000000000
      repo.setStartedAt(projectId, loopName, 0, ms)
      expect(repo.get(projectId, loopName, 0)?.startedAt).toBe(ms)
    })
  })

  describe('setCompletedAt', () => {
    test('sets the completed timestamp', () => {
      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })

      const ms = 1700000001000
      repo.setCompletedAt(projectId, loopName, 0, ms)
      expect(repo.get(projectId, loopName, 0)?.completedAt).toBe(ms)
    })
  })

  describe('incrementAttempts', () => {
    test('increments attempt counter', () => {
      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })

      expect(repo.get(projectId, loopName, 0)?.attempts).toBe(0)
      repo.incrementAttempts(projectId, loopName, 0)
      expect(repo.get(projectId, loopName, 0)?.attempts).toBe(1)
      repo.incrementAttempts(projectId, loopName, 0)
      expect(repo.get(projectId, loopName, 0)?.attempts).toBe(2)
    })
  })

  describe('resetForRewind', () => {
    test('resets section to in_progress with cleared fields', () => {
      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })

      repo.setStatus(projectId, loopName, 0, 'completed')
      repo.setStartedAt(projectId, loopName, 0, 1000)
      repo.setCompletedAt(projectId, loopName, 0, 2000)
      repo.setSummary(projectId, loopName, 0, { done: 'Done', deviations: 'Dev', followUps: 'FU' })
      repo.incrementAttempts(projectId, loopName, 0)

      repo.resetForRewind(projectId, loopName, 0)
      const row = repo.get(projectId, loopName, 0)
      expect(row?.status).toBe('in_progress')
      expect(row?.attempts).toBe(0)
      expect(row?.summaryDone).toBeNull()
      expect(row?.summaryDeviations).toBeNull()
      expect(row?.summaryFollowUps).toBeNull()
      expect(row?.completedAt).toBeNull()
    })
  })

  describe('getNextIncomplete', () => {
    test('returns null when no sections exist', () => {
      expect(repo.getNextIncomplete(projectId, loopName)).toBeNull()
    })

    test('returns section 0 when all sections are initially pending', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'A', content: 'A content' },
        { index: 1, title: 'B', content: 'B content' },
      ]
      repo.bulkInsert({ projectId, loopName, sections })

      const result = repo.getNextIncomplete(projectId, loopName)
      expect(result).not.toBeNull()
      expect(result!.sectionIndex).toBe(0)
    })

    test('skips completed sections and returns the lowest-index pending', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'A', content: 'A content' },
        { index: 1, title: 'B', content: 'B content' },
        { index: 2, title: 'C', content: 'C content' },
      ]
      repo.bulkInsert({ projectId, loopName, sections })
      repo.setStatus(projectId, loopName, 0, 'completed')

      const result = repo.getNextIncomplete(projectId, loopName)
      expect(result).not.toBeNull()
      expect(result!.sectionIndex).toBe(1)
    })

    test('treats failed as incomplete and returns a lower-index failed before a later pending', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'A', content: 'A content' },
        { index: 1, title: 'B', content: 'B content' },
      ]
      repo.bulkInsert({ projectId, loopName, sections })
      repo.setStatus(projectId, loopName, 0, 'failed')
      repo.setStatus(projectId, loopName, 1, 'pending')

      const result = repo.getNextIncomplete(projectId, loopName)
      expect(result).not.toBeNull()
      expect(result!.sectionIndex).toBe(0)
      expect(result!.status).toBe('failed')
    })

    test('returns null when all sections are completed', () => {
      const sections: ParsedSection[] = [
        { index: 0, title: 'A', content: 'A content' },
        { index: 1, title: 'B', content: 'B content' },
      ]
      repo.bulkInsert({ projectId, loopName, sections })
      repo.setStatus(projectId, loopName, 0, 'completed')
      repo.setStatus(projectId, loopName, 1, 'completed')

      expect(repo.getNextIncomplete(projectId, loopName)).toBeNull()
    })

    test('scopes by projectId and loopName', () => {
      const otherProject = 'other-project'
      db.run(`INSERT INTO loops (project_id, loop_name) VALUES (?, ?)`, [otherProject, loopName])

      const sections: ParsedSection[] = [{ index: 0, title: 'A', content: 'A content' }]
      repo.bulkInsert({ projectId, loopName, sections })
      repo.bulkInsert({ projectId: otherProject, loopName, sections })
      repo.setStatus(projectId, loopName, 0, 'completed')

      expect(repo.getNextIncomplete(projectId, loopName)).toBeNull()
      expect(repo.getNextIncomplete(otherProject, loopName)!.sectionIndex).toBe(0)
    })
  })

  describe('count', () => {
    test('returns correct count', () => {
      expect(repo.count(projectId, loopName)).toBe(0)

      const sections: ParsedSection[] = [
        { index: 0, title: 'A', content: 'A' },
        { index: 1, title: 'B', content: 'B' },
        { index: 2, title: 'C', content: 'C' },
      ]
      repo.bulkInsert({ projectId, loopName, sections })
      expect(repo.count(projectId, loopName)).toBe(3)
    })

    test('counts per project and loop', () => {
      const otherLoop = 'other-loop'
      db.run(`INSERT INTO loops (project_id, loop_name) VALUES (?, ?)`, [projectId, otherLoop])

      const sections: ParsedSection[] = [{ index: 0, title: 'S', content: 'C' }]
      repo.bulkInsert({ projectId, loopName, sections })
      repo.bulkInsert({ projectId, loopName: otherLoop, sections })

      expect(repo.count(projectId, loopName)).toBe(1)
      expect(repo.count(projectId, otherLoop)).toBe(1)
    })
  })
})
