import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createLoopService } from '../src/services/loop'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-loop-findings-gate-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS loops (
      project_id           TEXT NOT NULL,
      loop_name            TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id   TEXT NOT NULL,
      worktree             INTEGER NOT NULL,
      worktree_dir         TEXT NOT NULL,
      worktree_branch      TEXT,
      project_dir          TEXT NOT NULL,
      max_iterations       INTEGER NOT NULL,
      iteration            INTEGER NOT NULL DEFAULT 0,
      audit_count          INTEGER NOT NULL DEFAULT 0,
      error_count          INTEGER NOT NULL DEFAULT 0,
      phase                TEXT NOT NULL CHECK(phase IN ('coding','auditing')),
      execution_model      TEXT,
      auditor_model        TEXT,
      model_failed         INTEGER NOT NULL DEFAULT 0,
      sandbox              INTEGER NOT NULL DEFAULT 0,
      sandbox_container    TEXT,
      started_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      termination_reason   TEXT,
      completion_summary   TEXT,
      workspace_id         TEXT,
      host_session_id      TEXT,
      session_directory    TEXT,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  db.run(`CREATE UNIQUE INDEX idx_loops_session ON loops(project_id, current_session_id)`)
  
  db.run(`
    CREATE TABLE IF NOT EXISTS loop_large_fields (
      project_id          TEXT NOT NULL,
      loop_name           TEXT NOT NULL,
      prompt              TEXT,
      last_audit_result   TEXT,
      PRIMARY KEY (project_id, loop_name),
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    )
  `)
  
  db.run(`
    CREATE TABLE IF NOT EXISTS plans (
      project_id   TEXT NOT NULL,
      loop_name    TEXT,
      session_id   TEXT,
      content      TEXT NOT NULL,
      updated_at   INTEGER NOT NULL,
      CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
      CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL))
    )
  `)
  
  db.run(`
    CREATE TABLE IF NOT EXISTS review_findings (
      project_id   TEXT NOT NULL,
      loop_name    TEXT NOT NULL DEFAULT '',
      file         TEXT NOT NULL,
      line         INTEGER NOT NULL,
      severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description  TEXT NOT NULL,
      scenario     TEXT,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, loop_name, file, line)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_review_findings_loop_name ON review_findings(project_id, loop_name)`)
  
  return db
}

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('Loop findings gate', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)
  })

  afterEach(() => {
    db.close()
  })

  test('getOutstandingFindings returns bug findings for specific loop', () => {
    // Seed a bug finding for loop "alpha"
    reviewFindingsRepo.write({
      projectId,
      file: 'src/alpha.ts',
      line: 1,
      severity: 'bug',
      description: 'Alpha loop bug',
      loopName: 'alpha',
    })

    const bugFindings = loopService.getOutstandingFindings('alpha', 'bug')
    expect(bugFindings).toHaveLength(1)
    expect(bugFindings[0].description).toBe('Alpha loop bug')
    expect(bugFindings[0].severity).toBe('bug')
  })

  test('getOutstandingFindings is isolated by loop', () => {
    // Seed findings for two different loops
    reviewFindingsRepo.write({
      projectId,
      file: 'src/alpha.ts',
      line: 1,
      severity: 'bug',
      description: 'Alpha loop bug',
      loopName: 'alpha',
    })
    reviewFindingsRepo.write({
      projectId,
      file: 'src/beta.ts',
      line: 2,
      severity: 'warning',
      description: 'Beta loop warning',
      loopName: 'beta',
    })

    // Alpha should only see alpha findings
    const alphaFindings = loopService.getOutstandingFindings('alpha')
    expect(alphaFindings).toHaveLength(1)
    expect(alphaFindings[0].loopName).toBe('alpha')

    // Beta should only see beta findings
    const betaFindings = loopService.getOutstandingFindings('beta')
    expect(betaFindings).toHaveLength(1)
    expect(betaFindings[0].loopName).toBe('beta')

    // Alpha bug findings should be empty for beta
    const alphaBugForBeta = loopService.getOutstandingFindings('beta', 'bug')
    expect(alphaBugForBeta).toHaveLength(0)
  })

  test('hasOutstandingFindings returns true for bug in loop', () => {
    reviewFindingsRepo.write({
      projectId,
      file: 'src/test.ts',
      line: 10,
      severity: 'bug',
      description: 'Test bug',
      loopName: 'test-loop',
    })

    const hasBugs = loopService.hasOutstandingFindings('test-loop', 'bug')
    expect(hasBugs).toBe(true)
  })

  test('hasOutstandingFindings returns false when no bugs in loop', () => {
    reviewFindingsRepo.write({
      projectId,
      file: 'src/test.ts',
      line: 10,
      severity: 'warning',
      description: 'Test warning',
      loopName: 'test-loop',
    })

    const hasBugs = loopService.hasOutstandingFindings('test-loop', 'bug')
    expect(hasBugs).toBe(false)
  })

  test('getOutstandingFindings returns empty for non-existent loop', () => {
    const findings = loopService.getOutstandingFindings('non-existent-loop')
    expect(findings).toHaveLength(0)
  })
})
