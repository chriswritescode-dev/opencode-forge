import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createReviewFindingsRepo, type ReviewFindingRow } from '../src/storage'

const TEST_DIR = '/tmp/opencode-review-findings-repo-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS review_findings (
      project_id   TEXT NOT NULL,
      file         TEXT NOT NULL,
      line         INTEGER NOT NULL,
      severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description  TEXT NOT NULL,
      scenario     TEXT,
      branch       TEXT,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, file, line)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_review_findings_branch ON review_findings(project_id, branch)`)
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

  describe('write', () => {
    test('writes a finding', () => {
      const now = Date.now()
      const result = repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'bug',
        description: 'Example bug',
        scenario: 'When example input is used',
        branch: 'main',
      })

      expect(result.ok).toBe(true)
      expect(result.conflict).toBeUndefined()

      const findings = repo.listAll(projectId)
      expect(findings).toHaveLength(1)
      expect(findings[0].file).toBe('src/example.ts')
      expect(findings[0].line).toBe(12)
      expect(findings[0].severity).toBe('bug')
      expect(findings[0].branch).toBe('main')
      expect(findings[0].createdAt).toBeGreaterThan(now - 1000)
    })

    test('returns conflict on duplicate file:line', () => {
      repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'bug',
        description: 'First finding',
        scenario: 'Scenario 1',
        branch: 'main',
      })

      const result = repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'warning',
        description: 'Second finding',
        scenario: 'Scenario 2',
        branch: 'feature',
      })

      expect(result.ok).toBe(false)
      expect(result.conflict).toBe(true)

      // Original finding should be unchanged
      const findings = repo.listAll(projectId)
      expect(findings).toHaveLength(1)
      expect(findings[0].description).toBe('First finding')
      expect(findings[0].severity).toBe('bug')
    })

    test('allows different lines in same file', () => {
      repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'bug',
        description: 'Line 12',
        scenario: 'Scenario',
        branch: 'main',
      })

      const result = repo.write({
        projectId,
        file: 'src/example.ts',
        line: 42,
        severity: 'warning',
        description: 'Line 42',
        scenario: 'Scenario',
        branch: 'main',
      })

      expect(result.ok).toBe(true)
      expect(repo.listAll(projectId)).toHaveLength(2)
    })

    test('allows same line in different files', () => {
      repo.write({
        projectId,
        file: 'src/file1.ts',
        line: 12,
        severity: 'bug',
        description: 'File 1',
        scenario: 'Scenario',
        branch: 'main',
      })

      const result = repo.write({
        projectId,
        file: 'src/file2.ts',
        line: 12,
        severity: 'warning',
        description: 'File 2',
        scenario: 'Scenario',
        branch: 'main',
      })

      expect(result.ok).toBe(true)
      expect(repo.listAll(projectId)).toHaveLength(2)
    })

    test('handles null branch', () => {
      const result = repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'bug',
        description: 'No branch',
        scenario: 'Scenario',
        branch: null,
      })

      expect(result.ok).toBe(true)
      const findings = repo.listAll(projectId)
      expect(findings[0].branch).toBeNull()
    })
  })

  describe('listAll', () => {
    test('returns empty array when no findings', () => {
      const findings = repo.listAll(projectId)
      expect(findings).toEqual([])
    })

    test('returns all findings for project', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'A',
        scenario: 'S',
        branch: 'main',
      })
      repo.write({
        projectId,
        file: 'src/b.ts',
        line: 2,
        severity: 'warning',
        description: 'B',
        scenario: 'S',
        branch: 'main',
      })

      const findings = repo.listAll(projectId)
      expect(findings).toHaveLength(2)
    })

    test('does not return findings for other projects', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'A',
        scenario: 'S',
        branch: 'main',
      })

      const otherFindings = repo.listAll('other-project')
      expect(otherFindings).toEqual([])
    })
  })

  describe('listByBranch', () => {
    test('returns findings for specific branch', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'Main',
        scenario: 'S',
        branch: 'main',
      })
      repo.write({
        projectId,
        file: 'src/b.ts',
        line: 2,
        severity: 'warning',
        description: 'Feature',
        scenario: 'S',
        branch: 'feature',
      })

      const mainFindings = repo.listByBranch(projectId, 'main')
      expect(mainFindings).toHaveLength(1)
      expect(mainFindings[0].description).toBe('Main')
    })

    test('returns findings with null branch when branch is null', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'No branch',
        scenario: 'S',
        branch: null,
      })

      const findings = repo.listByBranch(projectId, null)
      expect(findings).toHaveLength(1)
      expect(findings[0].branch).toBeNull()
    })

    test('returns empty when no findings for branch', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'Main',
        scenario: 'S',
        branch: 'main',
      })

      const findings = repo.listByBranch(projectId, 'other')
      expect(findings).toEqual([])
    })
  })

  describe('listByFile', () => {
    test('returns findings for specific file', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'A1',
        scenario: 'S',
        branch: 'main',
      })
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 2,
        severity: 'warning',
        description: 'A2',
        scenario: 'S',
        branch: 'main',
      })
      repo.write({
        projectId,
        file: 'src/b.ts',
        line: 1,
        severity: 'bug',
        description: 'B1',
        scenario: 'S',
        branch: 'main',
      })

      const aFindings = repo.listByFile(projectId, 'src/a.ts')
      expect(aFindings).toHaveLength(2)
      expect(aFindings.map(f => f.description)).toEqual(['A1', 'A2'])
    })

    test('returns empty when no findings for file', () => {
      const findings = repo.listByFile(projectId, 'src/nonexistent.ts')
      expect(findings).toEqual([])
    })
  })

  describe('delete', () => {
    test('deletes existing finding', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'To delete',
        scenario: 'S',
        branch: 'main',
      })

      const deleted = repo.delete(projectId, 'src/a.ts', 1)
      expect(deleted).toBe(true)
      expect(repo.listAll(projectId)).toEqual([])
    })

    test('returns false for non-existent finding', () => {
      const deleted = repo.delete(projectId, 'src/nonexistent.ts', 1)
      expect(deleted).toBe(false)
    })

    test('deletes only specified line', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'Keep',
        scenario: 'S',
        branch: 'main',
      })
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 2,
        severity: 'warning',
        description: 'Delete',
        scenario: 'S',
        branch: 'main',
      })

      const deleted = repo.delete(projectId, 'src/a.ts', 2)
      expect(deleted).toBe(true)
      expect(repo.listAll(projectId)).toHaveLength(1)
      expect(repo.listAll(projectId)[0].description).toBe('Keep')
    })
  })
})
