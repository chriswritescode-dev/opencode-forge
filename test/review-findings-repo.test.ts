import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { createReviewFindingsRepo } from '../src/storage'

const TEST_DIR = '/tmp/opencode-review-findings-repo-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS review_findings (
      project_id   TEXT NOT NULL,
      loop_name    TEXT NOT NULL DEFAULT '',
      file         TEXT NOT NULL,
      line         INTEGER NOT NULL,
      severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description  TEXT NOT NULL,
      scenario     TEXT,
      section_index INTEGER,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, loop_name, file, line, section_index)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_review_findings_loop_name ON review_findings(project_id, loop_name)`)
  return db
}

describe('ReviewFindingsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createReviewFindingsRepo>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    repo = createReviewFindingsRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  test('writes a loop-scoped finding', () => {
    const now = Date.now()
    const result = repo.write({
      projectId,
      file: 'src/example.ts',
      line: 12,
      severity: 'bug',
      description: 'Example bug',
      scenario: 'When example input is used',
      loopName: 'alpha',
    })

    expect(result.ok).toBe(true)
    expect(result.conflict).toBeUndefined()

    const findings = repo.listAll(projectId)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      projectId,
      file: 'src/example.ts',
      line: 12,
      severity: 'bug',
      description: 'Example bug',
      scenario: 'When example input is used',
      loopName: 'alpha',
    })
    expect(findings[0].createdAt).toBeGreaterThan(now - 1000)
  })

  test('returns conflict on duplicate file:line in same loop and same section', () => {
    repo.write({
      projectId,
      file: 'src/example.ts',
      line: 12,
      severity: 'bug',
      description: 'First finding',
      scenario: 'Scenario 1',
      loopName: 'alpha',
      sectionIndex: 0,
    })

    const result = repo.write({
      projectId,
      file: 'src/example.ts',
      line: 12,
      severity: 'warning',
      description: 'Second finding',
      scenario: 'Scenario 2',
      loopName: 'alpha',
      sectionIndex: 0,
    })

    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(true)
    expect(repo.listAll(projectId)).toHaveLength(1)
    expect(repo.listAll(projectId)[0].description).toBe('First finding')
  })

  test('allows same file:line in different sections', () => {
    repo.write({
      projectId,
      file: 'src/example.ts',
      line: 12,
      severity: 'bug',
      description: 'Section 0 finding',
      scenario: 'Scenario 1',
      loopName: 'alpha',
      sectionIndex: 0,
    })

    const result = repo.write({
      projectId,
      file: 'src/example.ts',
      line: 12,
      severity: 'warning',
      description: 'Section 1 finding',
      scenario: 'Scenario 2',
      loopName: 'alpha',
      sectionIndex: 1,
    })

    expect(result.ok).toBe(true)
    expect(result.conflict).toBeUndefined()
    expect(repo.listAll(projectId)).toHaveLength(2)
  })

  test('allows same file:line on different loop names', () => {
    repo.write({
      projectId,
      file: 'src/example.ts',
      line: 12,
      severity: 'bug',
      description: 'Loop alpha finding',
      scenario: 'Scenario 1',
      loopName: 'alpha',
    })

    const result = repo.write({
      projectId,
      file: 'src/example.ts',
      line: 12,
      severity: 'warning',
      description: 'Loop beta finding',
      scenario: 'Scenario 2',
      loopName: 'beta',
    })

    expect(result.ok).toBe(true)
    expect(result.conflict).toBeUndefined()
    expect(repo.listAll(projectId)).toHaveLength(2)
  })

  test('supports findings without loop scope', () => {
    const result = repo.write({
      projectId,
      file: 'src/example.ts',
      line: 12,
      severity: 'bug',
      description: 'No scope',
      scenario: 'Scenario',
      loopName: null,
    })

    expect(result.ok).toBe(true)
    expect(repo.listByLoopName(projectId, null)[0].loopName).toBeNull()
  })

  test('lists only findings for requested project', () => {
    repo.write({
      projectId,
      file: 'src/a.ts',
      line: 1,
      severity: 'bug',
      description: 'A',
      scenario: 'S',
      loopName: 'alpha',
    })

    expect(repo.listAll('other-project')).toEqual([])
  })

  test('lists findings for specific loop', () => {
    repo.write({
      projectId,
      file: 'src/a.ts',
      line: 1,
      severity: 'bug',
      description: 'Alpha loop',
      scenario: 'S',
      loopName: 'alpha',
    })
    repo.write({
      projectId,
      file: 'src/b.ts',
      line: 2,
      severity: 'warning',
      description: 'Beta loop',
      scenario: 'S',
      loopName: 'beta',
    })

    const alphaFindings = repo.listByLoopName(projectId, 'alpha')
    expect(alphaFindings).toHaveLength(1)
    expect(alphaFindings[0].description).toBe('Alpha loop')
  })

  test('lists findings for specific file', () => {
    repo.write({ projectId, file: 'src/a.ts', line: 1, severity: 'bug', description: 'A1', scenario: 'S', loopName: 'alpha' })
    repo.write({ projectId, file: 'src/a.ts', line: 2, severity: 'warning', description: 'A2', scenario: 'S', loopName: 'alpha' })
    repo.write({ projectId, file: 'src/b.ts', line: 1, severity: 'bug', description: 'B1', scenario: 'S', loopName: 'alpha' })

    const aFindings = repo.listByFile(projectId, 'src/a.ts')
    expect(aFindings).toHaveLength(2)
    expect(aFindings.map(f => f.description)).toEqual(['A1', 'A2'])
  })

  test('deletes existing finding', () => {
    repo.write({ projectId, file: 'src/a.ts', line: 1, severity: 'bug', description: 'To delete', scenario: 'S', loopName: 'alpha' })

    expect(repo.delete(projectId, 'src/a.ts', 1)).toBe(true)
    expect(repo.listAll(projectId)).toEqual([])
  })

  test('delete with loopName parameter only deletes that loop', () => {
    repo.write({ projectId, file: 'src/a.ts', line: 1, severity: 'bug', description: 'Alpha finding', scenario: 'S', loopName: 'alpha' })
    repo.write({ projectId, file: 'src/a.ts', line: 1, severity: 'warning', description: 'Beta finding', scenario: 'S', loopName: 'beta' })

    expect(repo.delete(projectId, 'src/a.ts', 1, { loopName: 'alpha' })).toBe(true)
    const remaining = repo.listAll(projectId)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].loopName).toBe('beta')
  })

  test('duplicate NULL section_index on same file:line produces conflict', () => {
    repo.write({
      projectId,
      file: 'src/a.ts',
      line: 10,
      severity: 'bug',
      description: 'First cross-section finding',
      scenario: null,
      loopName: 'alpha',
      sectionIndex: null,
    })

    const result = repo.write({
      projectId,
      file: 'src/a.ts',
      line: 10,
      severity: 'warning',
      description: 'Second cross-section finding',
      scenario: null,
      loopName: 'alpha',
      sectionIndex: null,
    })

    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(true)
    expect(repo.listAll(projectId)).toHaveLength(1)
    expect(repo.listAll(projectId)[0].description).toBe('First cross-section finding')
  })

  test('NULL section_index deduplication works after COALESCE fix', () => {
    const r1 = repo.write({
      projectId,
      file: 'src/a.ts',
      line: 10,
      severity: 'bug',
      description: 'Cross-section 1',
      scenario: null,
      loopName: 'alpha',
      sectionIndex: null,
    })
    expect(r1.ok).toBe(true)

    const r2 = repo.write({
      projectId,
      file: 'src/a.ts',
      line: 10,
      severity: 'bug',
      description: 'Cross-section 2',
      scenario: null,
      loopName: 'alpha',
      sectionIndex: null,
    })
    expect(r2.ok).toBe(false)
    expect(r2.conflict).toBe(true)

    const r3 = repo.write({
      projectId,
      file: 'src/a.ts',
      line: 10,
      severity: 'warning',
      description: 'Section 0 finding',
      scenario: null,
      loopName: 'alpha',
      sectionIndex: 0,
    })
    expect(r3.ok).toBe(true)
    expect(repo.listAll(projectId)).toHaveLength(2)
  })

  test('delete with null sectionIndex removes sentinel rows', () => {
    repo.write({
      projectId,
      file: 'src/a.ts',
      line: 10,
      severity: 'bug',
      description: 'To delete',
      scenario: null,
      loopName: 'alpha',
      sectionIndex: null,
    })
    expect(repo.listAll(projectId)).toHaveLength(1)

    const deleted = repo.delete(projectId, 'src/a.ts', 10, { loopName: 'alpha', sectionIndex: null })
    expect(deleted).toBe(true)
    expect(repo.listAll(projectId)).toHaveLength(0)
  })
})
