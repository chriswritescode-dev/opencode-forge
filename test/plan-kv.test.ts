import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopService } from '../src/loop/service'
import { createPlanTools } from '../src/tools/plan-kv'
import { openForgeDatabase } from '../src/storage/database'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-manager-plan-kv-test-' + Date.now()

function createTestDb(): Database {
  return openForgeDatabase(join(tmpdir(), `forge-test-${randomUUID()}.db`))
}

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

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

    const lines = String(result).split('\n').filter((l) => l.match(/^\d+:/))
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
})
