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
      audit                INTEGER NOT NULL,
      execution_model      TEXT,
      auditor_model        TEXT,
      model_failed         INTEGER NOT NULL DEFAULT 0,
      sandbox              INTEGER NOT NULL DEFAULT 0,
      sandbox_container    TEXT,
      started_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      termination_reason   TEXT,
      completion_summary   TEXT,
      workspace_id   TEXT,
      host_session_id   TEXT,
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
      file         TEXT NOT NULL,
      line         INTEGER NOT NULL,
      severity     TEXT NOT NULL CHECK(severity IN ('bug','warning')),
      description  TEXT NOT NULL,
      scenario     TEXT NOT NULL,
      branch       TEXT,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, file, line)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_review_findings_branch ON review_findings(project_id, branch)`)
  
  db.run(`
    CREATE TABLE IF NOT EXISTS graph_status (
      project_id   TEXT NOT NULL,
      cwd          TEXT NOT NULL DEFAULT '',
      state        TEXT NOT NULL,
      ready        INTEGER NOT NULL,
      stats_json   TEXT,
      message      TEXT,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, cwd)
    )
  `)
  
  return db
}

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

function createToolContext(db: Database, reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>, loopService: ReturnType<typeof createLoopService>) {
  const plansRepo = createPlansRepo(db)
  return {
    reviewFindingsRepo,
    plansRepo,
    projectId: 'test-project',
    logger: mockLogger,
    loopService,
    directory: TEST_DIR,
    config: {} as any,
    db,
    dataDir: TEST_DIR,
    cleanup: async () => {},
    input: {} as any,
    sandboxManager: null,
    graphService: null,
    v2: {} as any,
    loopHandler: {} as any,
    graphStatusRepo: {} as any,
  }
}

describe('review-write', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createReviewTools>

  beforeEach(() => {
    db = createTestDb()
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    const ctx = createToolContext(db, reviewFindingsRepo, loopService)
    tools = createReviewTools(ctx)
  })

  afterEach(() => {
    db.close()
  })

  test('stores a review finding with automatic branch injection', async () => {
    const result = await tools['review-write'].execute(
      {
        file: 'src/services/auth.ts',
        line: 45,
        severity: 'bug',
        description: 'Missing null check',
        scenario: 'User session expires',
      },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Stored review finding')
    expect(result).toContain('src/services/auth.ts:45')
    expect(result).toContain('bug')
  })

  test('rejects duplicate finding at same file:line', async () => {
    // First write should succeed
    const result1 = await tools['review-write'].execute(
      {
        file: 'src/services/auth.ts',
        line: 45,
        severity: 'bug',
        description: 'Missing null check',
        scenario: 'User session expires',
      },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )
    expect(result1).toContain('Stored review finding')

    // Second write should fail with conflict
    const result2 = await tools['review-write'].execute(
      {
        file: 'src/services/auth.ts',
        line: 45,
        severity: 'warning',
        description: 'Different issue',
        scenario: 'Different scenario',
      },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )
    expect(result2).toContain('Finding already exists at')
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

    // Seed with test data
    reviewFindingsRepo.write({
      projectId: 'test-project',
      file: 'src/file1.ts',
      line: 10,
      severity: 'bug',
      description: 'Bug in file1',
      scenario: 'Scenario 1',
      branch: 'main',
    })
    reviewFindingsRepo.write({
      projectId: 'test-project',
      file: 'src/file2.ts',
      line: 20,
      severity: 'warning',
      description: 'Warning in file2',
      scenario: 'Scenario 2',
      branch: 'main',
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

    expect(result).toContain('2 review findings')
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
})

describe('review-delete', () => {
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

    // Seed with test data
    reviewFindingsRepo.write({
      projectId: 'test-project',
      file: 'src/file.ts',
      line: 10,
      severity: 'bug',
      description: 'Test bug',
      scenario: 'Test scenario',
      branch: 'main',
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
    expect(result).toContain('src/file.ts:10')

    const findings = reviewFindingsRepo.listByFile('test-project', 'src/file.ts')
    expect(findings.length).toBe(0)
  })

  test('returns not found message when finding does not exist', async () => {
    const result = await tools['review-delete'].execute(
      { file: 'src/nonexistent.ts', line: 10 },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('No review finding found at')
  })
})
