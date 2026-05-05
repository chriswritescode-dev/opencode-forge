import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createReviewFindingsRepo, type ReviewFindingRow } from '../src/storage'

const TEST_DIR = '/tmp/opencode-review-findings-repo-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS review_findings (
      project_id   TEXT NOT NULL,
      branch       TEXT NOT NULL DEFAULT '',
      loop_name    TEXT NOT NULL DEFAULT '',
      file         TEXT NOT NULL,
      line         INTEGER NOT NULL,
      severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description  TEXT NOT NULL,
      scenario     TEXT,
      created_at   INTEGER NOT NULL,
      CHECK (NOT (branch != '' AND loop_name != '')),
      PRIMARY KEY (project_id, branch, loop_name, file, line)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_review_findings_branch ON review_findings(project_id, branch)`)
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
        loopName: null,
      })

      expect(result.ok).toBe(true)
      expect(result.conflict).toBeUndefined()

      const findings = repo.listAll(projectId)
      expect(findings).toHaveLength(1)
      expect(findings[0].file).toBe('src/example.ts')
      expect(findings[0].line).toBe(12)
      expect(findings[0].severity).toBe('bug')
      expect(findings[0].branch).toBe('main')
      expect(findings[0].loopName).toBeNull()
      expect(findings[0].createdAt).toBeGreaterThan(now - 1000)
    })

    test('returns conflict on duplicate file:line on same branch', () => {
      repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'bug',
        description: 'First finding',
        scenario: 'Scenario 1',
        branch: 'main',
        loopName: null,
      })

      const result = repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'warning',
        description: 'Second finding',
        scenario: 'Scenario 2',
        branch: 'main',
        loopName: null,
      })

      expect(result.ok).toBe(false)
      expect(result.conflict).toBe(true)

      // Original finding should be unchanged
      const findings = repo.listAll(projectId)
      expect(findings).toHaveLength(1)
      expect(findings[0].description).toBe('First finding')
      expect(findings[0].severity).toBe('bug')
    })

    test('allows same file:line on different branches', () => {
      repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'bug',
        description: 'First finding',
        scenario: 'Scenario 1',
        branch: 'main',
        loopName: null,
      })

      const result = repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'warning',
        description: 'Second finding',
        scenario: 'Scenario 2',
        branch: 'feature',
        loopName: null,
      })

      expect(result.ok).toBe(true)
      expect(result.conflict).toBeUndefined()

      const findings = repo.listAll(projectId)
      expect(findings).toHaveLength(2)
      expect(findings.some(f => f.description === 'First finding')).toBe(true)
      expect(findings.some(f => f.description === 'Second finding')).toBe(true)
    })

    test('allows same file:line on different loop names', () => {
      repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'bug',
        description: 'Loop alpha finding',
        scenario: 'Scenario 1',
        branch: null,
        loopName: 'alpha',
      })

      const result = repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'warning',
        description: 'Loop beta finding',
        scenario: 'Scenario 2',
        branch: null,
        loopName: 'beta',
      })

      expect(result.ok).toBe(true)
      expect(result.conflict).toBeUndefined()

      const findings = repo.listAll(projectId)
      expect(findings).toHaveLength(2)
      expect(findings.some(f => f.description === 'Loop alpha finding')).toBe(true)
      expect(findings.some(f => f.description === 'Loop beta finding')).toBe(true)
    })

    test('throws when both branch and loopName are set', () => {
      expect(() => {
        repo.write({
          projectId,
          file: 'src/example.ts',
          line: 12,
          severity: 'bug',
          description: 'Invalid finding',
          scenario: 'Scenario',
          branch: 'main',
          loopName: 'alpha',
        })
      }).toThrow('both branch and loopName')
    })

    test('handles null branch and null loopName', () => {
      const result = repo.write({
        projectId,
        file: 'src/example.ts',
        line: 12,
        severity: 'bug',
        description: 'No scope',
        scenario: 'Scenario',
        branch: null,
        loopName: null,
      })

      expect(result.ok).toBe(true)
      const findings = repo.listAll(projectId)
      expect(findings[0].branch).toBeNull()
      expect(findings[0].loopName).toBeNull()
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
        loopName: null,
      })
      repo.write({
        projectId,
        file: 'src/b.ts',
        line: 2,
        severity: 'warning',
        description: 'B',
        scenario: 'S',
        branch: 'main',
        loopName: null,
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
        loopName: null,
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
        loopName: null,
      })
      repo.write({
        projectId,
        file: 'src/b.ts',
        line: 2,
        severity: 'warning',
        description: 'Feature',
        scenario: 'S',
        branch: 'feature',
        loopName: null,
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
        loopName: null,
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
        loopName: null,
      })

      const findings = repo.listByBranch(projectId, 'other')
      expect(findings).toEqual([])
    })
  })

  describe('listByLoopName', () => {
    test('returns findings for specific loop', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'Alpha loop',
        scenario: 'S',
        branch: null,
        loopName: 'alpha',
      })
      repo.write({
        projectId,
        file: 'src/b.ts',
        line: 2,
        severity: 'warning',
        description: 'Beta loop',
        scenario: 'S',
        branch: null,
        loopName: 'beta',
      })

      const alphaFindings = repo.listByLoopName(projectId, 'alpha')
      expect(alphaFindings).toHaveLength(1)
      expect(alphaFindings[0].description).toBe('Alpha loop')
    })

    test('returns findings with null loopName when loopName is null', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'No loop',
        scenario: 'S',
        branch: null,
        loopName: null,
      })

      const findings = repo.listByLoopName(projectId, null)
      expect(findings).toHaveLength(1)
      expect(findings[0].loopName).toBeNull()
    })

    test('returns empty when no findings for loop', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'Alpha loop',
        scenario: 'S',
        branch: null,
        loopName: 'alpha',
      })

      const findings = repo.listByLoopName(projectId, 'beta')
      expect(findings).toEqual([])
    })

    test('returns empty array when no findings exist', () => {
      const findings = repo.listByLoopName(projectId, 'alpha')
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
        loopName: null,
      })
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 2,
        severity: 'warning',
        description: 'A2',
        scenario: 'S',
        branch: 'main',
        loopName: null,
      })
      repo.write({
        projectId,
        file: 'src/b.ts',
        line: 1,
        severity: 'bug',
        description: 'B1',
        scenario: 'S',
        branch: 'main',
        loopName: null,
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
        loopName: null,
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
        loopName: null,
      })
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 2,
        severity: 'warning',
        description: 'Delete',
        scenario: 'S',
        branch: 'main',
        loopName: null,
      })

      const deleted = repo.delete(projectId, 'src/a.ts', 2)
      expect(deleted).toBe(true)
      expect(repo.listAll(projectId)).toHaveLength(1)
      expect(repo.listAll(projectId)[0].description).toBe('Keep')
    })

    test('delete with branch parameter only deletes that branch', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'Main finding',
        scenario: 'S',
        branch: 'main',
        loopName: null,
      })
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'warning',
        description: 'Feature finding',
        scenario: 'S',
        branch: 'feature',
        loopName: null,
      })

      const deleted = repo.delete(projectId, 'src/a.ts', 1, { branch: 'main' })
      expect(deleted).toBe(true)
      
      const remaining = repo.listAll(projectId)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].branch).toBe('feature')
    })

    test('delete with loopName parameter only deletes that loop', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'Alpha finding',
        scenario: 'S',
        branch: null,
        loopName: 'alpha',
      })
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'warning',
        description: 'Beta finding',
        scenario: 'S',
        branch: null,
        loopName: 'beta',
      })

      const deleted = repo.delete(projectId, 'src/a.ts', 1, { loopName: 'alpha' })
      expect(deleted).toBe(true)
      
      const remaining = repo.listAll(projectId)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].loopName).toBe('beta')
    })

    test('delete without scope parameter deletes all scopes', () => {
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'Main finding',
        scenario: 'S',
        branch: 'main',
        loopName: null,
      })
      repo.write({
        projectId,
        file: 'src/a.ts',
        line: 1,
        severity: 'warning',
        description: 'Feature finding',
        scenario: 'S',
        branch: 'feature',
        loopName: null,
      })

      const deleted = repo.delete(projectId, 'src/a.ts', 1)
      expect(deleted).toBe(true)
      expect(repo.listAll(projectId)).toEqual([])
    })
  })
})
