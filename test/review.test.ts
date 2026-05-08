import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createReviewTools } from '../src/tools/review'
import { createLoopService } from '../src/services/loop'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-manager-review-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  // Create the new tables
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
      section_index INTEGER,
      PRIMARY KEY (project_id, loop_name, file, line, section_index)
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

function createToolContext(db: Database, reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>, loopService: ReturnType<typeof createLoopService>) {
  const plansRepo = createPlansRepo(db)
  const loopsRepo = createLoopsRepo(db)
  return {
    reviewFindingsRepo,
    plansRepo,
    loopsRepo,
    projectId: 'test-project',
    logger: mockLogger,
    loopService,
    directory: TEST_DIR,
  }
}

describe('review-write', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createReviewTools>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>

  beforeEach(() => {
    db = createTestDb()
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    const ctx = createToolContext(db, reviewFindingsRepo, loopService)
    tools = createReviewTools(ctx)
  })

  afterEach(() => {
    db.close()
  })

  test('writes a review finding', async () => {
    const result = await tools['review-write'].execute(
      {
        file: 'src/example.ts',
        line: 42,
        severity: 'bug',
        description: 'Test bug',
        scenario: 'When running tests',
      },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Stored review finding')
    expect(result).toContain('src/example.ts:42')
    expect(result).toContain('bug')

    const findings = reviewFindingsRepo.listAll('test-project')
    expect(findings).toHaveLength(1)
    expect(findings[0].file).toBe('src/example.ts')
    expect(findings[0].line).toBe(42)
  })

  test('inside a loop session writes loop_name and empty branch', async () => {
    // Register a loop session
    const loopsRepo = createLoopsRepo(db)
    loopsRepo.insert({
      projectId: 'test-project',
      loopName: 'test-loop',
      status: 'running',
      currentSessionId: 'loop-session-123',
      worktree: false,
      worktreeDir: TEST_DIR,
      worktreeBranch: 'feature-branch',
      projectDir: TEST_DIR,
      maxIterations: 10,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding',
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      completedAt: null,
      terminationReason: null,
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      startedAt: Date.now(),
    }, { prompt: null, lastAuditResult: null })

    const result = await tools['review-write'].execute(
      {
        file: 'src/loop-file.ts',
        line: 10,
        severity: 'warning',
        description: 'Loop finding',
      },
      { sessionID: 'loop-session-123', directory: TEST_DIR } as any
    )

    expect(result).toContain('Stored review finding')

    const findings = reviewFindingsRepo.listAll('test-project')
    expect(findings).toHaveLength(1)
    expect(findings[0].loopName).toBe('test-loop')
  })

  test('outside a loop session writes empty loop_name', async () => {
    const result = await tools['review-write'].execute(
      {
        file: 'src/branch-file.ts',
        line: 20,
        severity: 'bug',
        description: 'Branch finding',
      },
      { sessionID: 'non-loop-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Stored review finding')

    const findings = reviewFindingsRepo.listAll('test-project')
    expect(findings).toHaveLength(1)
    expect(findings[0].loopName).toBeNull()
  })
})

describe('review-read', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createReviewTools>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>

  beforeEach(() => {
    db = createTestDb()
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    const ctx = createToolContext(db, reviewFindingsRepo, loopService)
    tools = createReviewTools(ctx)

    // Seed with test data for different loops
    reviewFindingsRepo.write({
      projectId: 'test-project',
      file: 'src/file1.ts',
      line: 10,
      severity: 'bug',
      description: 'Bug in file1',
      scenario: 'Scenario 1',
      loopName: null,
    })
    reviewFindingsRepo.write({
      projectId: 'test-project',
      file: 'src/file2.ts',
      line: 20,
      severity: 'warning',
      description: 'Warning in file2',
      scenario: 'Scenario 2',
      loopName: null,
    })
    // Loop-specific findings
    reviewFindingsRepo.write({
      projectId: 'test-project',
      file: 'src/loop-alpha.ts',
      line: 1,
      severity: 'bug',
      description: 'Alpha loop bug',
      loopName: 'alpha',
    })
    reviewFindingsRepo.write({
      projectId: 'test-project',
      file: 'src/loop-beta.ts',
      line: 2,
      severity: 'warning',
      description: 'Beta loop warning',
      loopName: 'beta',
    })
  })

  afterEach(() => {
    db.close()
  })

  test('lists all findings when no args provided', async () => {
    const result = await tools['review-read'].execute(
      {},
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('4 review findings')
    expect(result).toContain('src/file1.ts:10')
    expect(result).toContain('src/file2.ts:20')
  })

  test('filters by file when file arg provided', async () => {
    const result = await tools['review-read'].execute(
      { file: 'src/file1.ts' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('1 review finding')
    expect(result).toContain('src/file1.ts:10')
    expect(result).not.toContain('src/file2.ts:20')
  })

  test('searches by pattern when pattern arg provided', async () => {
    const result = await tools['review-read'].execute(
      { pattern: 'Bug' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('1 review finding')
    expect(result).toContain('Bug in file1')
  })

  test('returns message when no findings found', async () => {
    const result = await tools['review-read'].execute(
      { file: 'nonexistent.ts' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('No review findings found')
  })

  test('inside a loop sees only its own findings', async () => {
    // Register alpha loop
    const loopsRepo = createLoopsRepo(db)
    loopsRepo.insert({
      projectId: 'test-project',
      loopName: 'alpha',
      status: 'running',
      currentSessionId: 'alpha-session',
      worktree: false,
      worktreeDir: TEST_DIR,
      worktreeBranch: 'alpha-branch',
      projectDir: TEST_DIR,
      maxIterations: 10,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding',
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      completedAt: null,
      terminationReason: null,
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      startedAt: Date.now(),
    }, { prompt: null, lastAuditResult: null })

    const result = await tools['review-read'].execute(
      {},
      { sessionID: 'alpha-session', directory: TEST_DIR } as any
    )

    // Should only see alpha loop findings (not beta, not branch-scoped)
    expect(result).toContain('1 review finding')
    expect(result).toContain('Alpha loop bug')
    expect(result).not.toContain('Beta loop warning')
  })
})

describe('review-delete', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createReviewTools>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let loopsRepo: ReturnType<typeof createLoopsRepo>

  beforeEach(() => {
    db = createTestDb()
    loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    const ctx = createToolContext(db, reviewFindingsRepo, loopService)
    tools = createReviewTools(ctx)

    // Seed with test data
    reviewFindingsRepo.write({
      projectId: 'test-project',
      file: 'src/file.ts',
      line: 10,
      severity: 'bug',
      description: 'Test bug',
      scenario: 'Test scenario',
      loopName: null,
    })
  })

  afterEach(() => {
    db.close()
  })

  test('deletes a review finding', async () => {
    const result = await tools['review-delete'].execute(
      { file: 'src/file.ts', line: 10 },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Deleted review finding')

    const findings = reviewFindingsRepo.listAll('test-project')
    expect(findings).toHaveLength(0)
  })

  test('inside a loop only deletes that loop row', async () => {
    // Write findings for two different loops at same file:line
    reviewFindingsRepo.write({
      projectId: 'test-project',
      file: 'src/shared.ts',
      line: 5,
      severity: 'bug',
      description: 'Alpha finding',
      loopName: 'alpha',
    })
    reviewFindingsRepo.write({
      projectId: 'test-project',
      file: 'src/shared.ts',
      line: 5,
      severity: 'warning',
      description: 'Beta finding',
      loopName: 'beta',
    })

    // Register alpha loop in the database
    loopsRepo.insert({
      projectId: 'test-project',
      loopName: 'alpha',
      status: 'running',
      currentSessionId: 'alpha-session',
      worktree: false,
      worktreeDir: TEST_DIR,
      worktreeBranch: 'alpha-branch',
      projectDir: TEST_DIR,
      maxIterations: 10,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding',
      executionModel: 'test-model',
      auditorModel: 'test-auditor',
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      completedAt: null,
      terminationReason: null,
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      startedAt: Date.now(),
    }, { prompt: null, lastAuditResult: null })

    // Delete from alpha loop context
    const result = await tools['review-delete'].execute(
      { file: 'src/shared.ts', line: 5 },
      { sessionID: 'alpha-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Deleted review finding')

    // Beta finding should still exist (along with the seeded 'Test bug' from beforeEach)
    const allFindings = reviewFindingsRepo.listAll('test-project')
    const sharedFindings = allFindings.filter(f => f.file === 'src/shared.ts')
    expect(sharedFindings).toHaveLength(1)
    expect(sharedFindings[0].loopName).toBe('beta')
    expect(sharedFindings[0].description).toBe('Beta finding')
  })
})
