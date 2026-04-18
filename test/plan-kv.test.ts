import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopService } from '../src/services/loop'
import { createPlanTools } from '../src/tools/plan-kv'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-manager-plan-kv-test-' + Date.now()

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
      audit                INTEGER NOT NULL DEFAULT 0,
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
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_loop ON plans(project_id, loop_name) WHERE loop_name IS NOT NULL`)
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_session ON plans(project_id, session_id) WHERE session_id IS NOT NULL`)
  
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
  
  return db
}

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('plan-write', () => {
  let db: Database
  let plansRepo: ReturnType<typeof createPlansRepo>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    plansRepo = createPlansRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    const ctx = {
      plansRepo,
      loopsRepo,
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
      reviewFindingsRepo,
      graphStatusRepo: {} as any,
    }
    tools = createPlanTools(ctx)
  })

  afterEach(() => {
    db.close()
  })

  test('writes plan content and auto-resolves key to session ID', async () => {
    const planContent = `# Implementation Plan

## Phase 1: Setup
- Create directory structure
- Initialize configuration

## Phase 2: Implementation
- Write core logic
- Add tests

## Verification
- Run tests
- Check types
`

    const result = await tools['plan-write'].execute(
      { content: planContent },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Plan stored')
    expect(result).toContain('lines')

    const stored = plansRepo.getForSession('test-project', 'test-session')
    expect(stored?.content).toBe(planContent)
  })

  test('overwrites existing plan', async () => {
    const initialPlan = '# Old Plan\n\nContent here'
    plansRepo.writeForSession('test-project', 'test-session', initialPlan)

    const newPlan = '# New Plan\n\nNew content'
    await tools['plan-write'].execute(
      { content: newPlan },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    const stored = plansRepo.getForSession('test-project', 'test-session')
    expect(stored?.content).toBe(newPlan)
  })
})

describe('plan-edit', () => {
  let db: Database
  let plansRepo: ReturnType<typeof createPlansRepo>
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    plansRepo = createPlansRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    tools = createPlanTools({
      plansRepo,
      projectId: 'test-project',
      logger: mockLogger,
      loopService,
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    } as any)

    // Seed with initial plan
    const initialPlan = `# Implementation Plan

## Phase 1: Setup
- Create directory structure
- Initialize configuration

## Phase 2: Implementation
- Write core logic
- Add tests
`
    plansRepo.writeForSession('test-project', 'test-session', initialPlan)
  })

  afterEach(() => {
    db.close()
  })

  test('edits plan by replacing old_string with new_string', async () => {
    const result = await tools['plan-edit'].execute(
      {
        old_string: '- Create directory structure',
        new_string: '- Create directory structure\n- Set up TypeScript',
      },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Plan updated')

    const stored = plansRepo.getForSession('test-project', 'test-session')
    expect(stored?.content).toContain('- Create directory structure')
    expect(stored?.content).toContain('- Set up TypeScript')
  })

  test('fails if old_string is not found', async () => {
    const result = await tools['plan-edit'].execute(
      {
        old_string: 'Non-existent string',
        new_string: 'New content',
      },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('old_string not found')
  })

  test('fails if old_string is not unique', async () => {
    const duplicatePlan = `# Plan

## Phase 1
- Item 1

## Phase 2
- Item 1
`
    plansRepo.writeForSession('test-project', 'test-session', duplicatePlan)

    const result = await tools['plan-edit'].execute(
      {
        old_string: '- Item 1',
        new_string: '- Updated item',
      },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('found 2 times')
    expect(result).toContain('must be unique')
  })

  test('fails if no plan exists', async () => {
    plansRepo.deleteForSession('test-project', 'test-session')

    const result = await tools['plan-edit'].execute(
      {
        old_string: 'Something',
        new_string: 'New',
      },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('No plan found')
  })
})

describe('plan-read', () => {
  let db: Database
  let plansRepo: ReturnType<typeof createPlansRepo>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    plansRepo = createPlansRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    tools = createPlanTools({
      plansRepo,
      loopsRepo,
      projectId: 'test-project',
      logger: mockLogger,
      loopService,
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    } as any)

    // Seed with test plan
    const planContent = `# Implementation Plan

## Phase 1: Setup
- Create directory structure
- Initialize configuration

## Phase 2: Implementation
- Write core logic
- Add tests

## Verification
- Run tests
- Check types
`
    plansRepo.writeForSession('test-project', 'test-session', planContent)
  })

  afterEach(() => {
    db.close()
  })

  test('reads plan with line-numbered output', async () => {
    const result = await tools['plan-read'].execute(
      {},
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('lines total')
    expect(result).toContain('1: # Implementation Plan')
    expect(result).toContain('3: ## Phase 1: Setup')
  })

  test('supports pagination with offset', async () => {
    const result = await tools['plan-read'].execute(
      { offset: 3 },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('3: ## Phase 1: Setup')
    expect(result).not.toContain('1: # Implementation Plan')
  })

  test('supports pagination with limit', async () => {
    const result = await tools['plan-read'].execute(
      { limit: 3 },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    const lines = result.split('\n').filter((l) => l.match(/^\d+:/))
    expect(lines.length).toBe(3)
  })

  test('searches by pattern', async () => {
    const result = await tools['plan-read'].execute(
      { pattern: 'Phase' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Found 2 matches')
    expect(result).toContain('Line 3:')
    expect(result).toContain('Line 7:')
  })

  test('returns message when no plan exists', async () => {
    plansRepo.deleteForSession('test-project', 'test-session')

    const result = await tools['plan-read'].execute(
      {},
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('No plan found')
  })

  test('returns message when pattern has no matches', async () => {
    const result = await tools['plan-read'].execute(
      { pattern: 'NonExistent' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('No matches found')
  })

  test('handles invalid regex pattern', async () => {
    const result = await tools['plan-read'].execute(
      { pattern: '[invalid' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Invalid regex pattern')
  })

  test('reads plan by explicit loop name', async () => {
    // Write to loop_large_fields (primary storage for loops)
    // First create the loop row, then update the prompt
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const testLoopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    const state = {
      active: true,
      sessionId: 'explicit-loop-session',
      loopName: 'explicit-loop',
      worktreeDir: '/tmp/test',
      projectDir: '/tmp/test',
      worktreeBranch: 'test-branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: '# Explicit Loop Plan\n\n## Phase 1\n- Read by loop name',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: undefined,
      auditorModel: undefined,
    }
    testLoopService.setState('explicit-loop', state)

    const result = await tools['plan-read'].execute(
      { loop_name: 'explicit-loop' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('# Explicit Loop Plan')
    expect(result).toContain('Read by loop name')
  })
})

describe('plan-read with loop session', () => {
  let db: Database
  let plansRepo: ReturnType<typeof createPlansRepo>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    plansRepo = createPlansRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    tools = createPlanTools({
      plansRepo,
      loopsRepo,
      projectId: 'test-project',
      logger: mockLogger,
      loopService: {
        resolveLoopName: (sessionID: string) =>
          sessionID === 'loop-session-123' ? 'my-loop' : null,
      } as any,
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    } as any)

    plansRepo.writeForLoop('test-project', 'my-loop', '# Loop Plan\n\n## Phase 1\n- Do the thing')
  })

  afterEach(() => {
    db.close()
  })

  test('resolves plan key to worktree name for loop sessions', async () => {
    // Write to loop_large_fields instead of plans table
    loopsRepo.updatePrompt('test-project', 'my-loop', '# Loop Plan\n\n## Phase 1\n- Do the thing')

    const result = await tools['plan-read'].execute(
      {},
      { sessionID: 'loop-session-123', directory: TEST_DIR } as any
    )

    expect(result).toContain('# Loop Plan')
    expect(result).toContain('Phase 1')
  })

  test('falls back to session ID when not in a loop', async () => {
    plansRepo.writeForSession('test-project', 'non-loop-session', '# Regular Plan')

    const result = await tools['plan-read'].execute(
      {},
      { sessionID: 'non-loop-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('# Regular Plan')
  })

  test('plan-write stores under worktree name for loop sessions', async () => {
    // First create the loop row so updatePrompt can work
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const testLoopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    const state = {
      active: true,
      sessionId: 'loop-session-123',
      loopName: 'my-loop',
      worktreeDir: '/tmp/test',
      projectDir: '/tmp/test',
      worktreeBranch: 'test-branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: '# Initial Plan',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: undefined,
      auditorModel: undefined,
    }
    testLoopService.setState('my-loop', state)

    await tools['plan-write'].execute(
      { content: '# Updated Loop Plan' },
      { sessionID: 'loop-session-123', directory: TEST_DIR } as any
    )

    // Check loop_large_fields first (primary storage for loops)
    const stored = loopsRepo.getLarge('test-project', 'my-loop')
    expect(stored?.prompt).toBe('# Updated Loop Plan')
  })

  test('plan-edit edits plan under worktree name for loop sessions', async () => {
    // First create the loop row so updatePrompt can work
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const testLoopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
    const state = {
      active: true,
      sessionId: 'loop-session-123',
      loopName: 'my-loop',
      worktreeDir: '/tmp/test',
      projectDir: '/tmp/test',
      worktreeBranch: 'test-branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: '# Loop Plan\n\n## Phase 1\n- Do the thing',
      phase: 'coding' as const,
      audit: true,
      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: undefined,
      auditorModel: undefined,
    }
    testLoopService.setState('my-loop', state)

    await tools['plan-edit'].execute(
      { old_string: '- Do the thing', new_string: '- Do the updated thing' },
      { sessionID: 'loop-session-123', directory: TEST_DIR } as any
    )

    // Check loop_large_fields first (primary storage for loops)
    const stored = loopsRepo.getLarge('test-project', 'my-loop')
    expect(stored?.prompt).toContain('- Do the updated thing')
  })
})
