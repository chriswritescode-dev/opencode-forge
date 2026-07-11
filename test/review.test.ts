import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { createReviewTools } from '../src/tools/review'
import { createLoopService } from '../src/loop/service'
import { createSessionLoopResolver } from '../src/services/session-loop-resolver'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { openForgeDatabase } from '../src/storage/database'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-manager-review-test-' + Date.now()

function createTestDb(): Database {
  return openForgeDatabase(join(tmpdir(), `forge-test-${randomUUID()}.db`))
}

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

function createToolContext(db: Database, reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>, loopService: ReturnType<typeof createLoopService>) {
  const plansRepo = createPlansRepo(db)
  const loopsRepo = createLoopsRepo(db)
  const sessionLoopResolver = createSessionLoopResolver({
    loop: { service: loopService, listActive: () => loopService.listActive() },
    getParentSessionId: async () => null,
    getSessionDirectory: async () => TEST_DIR,
    logger: mockLogger,
  })
  return {
    reviewFindingsRepo,
    plansRepo,
    loopsRepo,
    projectId: 'test-project',
    logger: mockLogger,
    loop: { service: loopService },
    directory: TEST_DIR,
    resolveActiveLoopForSession: sessionLoopResolver.resolveActiveLoopForSession,
  } as any
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
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: 0,
      executionVariant: null,
      auditorVariant: null,
      kind: 'plan',
    }, { lastAuditResult: null })

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

  test('outside a loop returns only non-loop findings', async () => {
    const result = await tools['review-read'].execute(
      {},
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('2 review findings')
    expect(result).toContain('src/file1.ts:10')
    expect(result).toContain('src/file2.ts:20')
    expect(result).not.toContain('Alpha loop bug')
    expect(result).not.toContain('Beta loop warning')
  })

  test('loopName targets a specific loop from outside that loop', async () => {
    const result = await tools['review-read'].execute(
      { loopName: 'alpha' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('1 review finding')
    expect(result).toContain('Alpha loop bug')
    expect(result).not.toContain('Beta loop warning')
    expect(result).not.toContain('src/file1.ts:10')
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
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: 0,
      executionVariant: null,
      auditorVariant: null,
      kind: 'plan',
    }, { lastAuditResult: null })

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
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: 0,
      executionVariant: null,
      auditorVariant: null,
      kind: 'plan',
    }, { lastAuditResult: null })

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
