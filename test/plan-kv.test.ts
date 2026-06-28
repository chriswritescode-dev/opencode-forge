import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
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
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    loopsRepo = createLoopsRepo(db)

    plansRepo = createPlansRepo(db)
    tools = createPlanTools({
      plansRepo,
      loopsRepo,
      projectId: 'test-project',
      logger: mockLogger,
      loop: {
        service: {
          resolveLoopName: () => null,
        },
      },
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
    // Write plan content directly via plans repo (no loop_large_fields.prompt dependency)
    plansRepo.writeForLoop('test-project', 'explicit-loop', '# Explicit Loop Plan\n\n## Phase 1\n- Read by loop name')

    const result = await tools['plan-read'].execute(
      { loop_name: 'explicit-loop' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('# Explicit Loop Plan')
    expect(result).toContain('Read by loop name')
  })

  test('reads plan by explicit session_id', async () => {
    plansRepo.writeForSession('test-project', 'target-session', '# Session Plan\n\nRead by session_id')

    const result = await tools['plan-read'].execute(
      { session_id: 'target-session' },
      { sessionID: 'other-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('# Session Plan')
    expect(result).toContain('Read by session_id')
  })
})

describe('plan-read with loop session', () => {
  let db: Database
  let plansRepo: ReturnType<typeof createPlansRepo>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    loopsRepo = createLoopsRepo(db)

    plansRepo = createPlansRepo(db)
    tools = createPlanTools({
      plansRepo,
      loopsRepo,
      projectId: 'test-project',
      logger: mockLogger,
      loop: {
        service: {
          resolveLoopName: (sessionID: string) =>
            sessionID === 'loop-session-123' ? 'my-loop' : null,
        },
      },
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

describe('plan-read with recent plans', () => {
  let db: Database
  let plansRepo: ReturnType<typeof createPlansRepo>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    loopsRepo = createLoopsRepo(db)

    plansRepo = createPlansRepo(db)
    tools = createPlanTools({
      plansRepo,
      loopsRepo,
      projectId: 'test-project',
      logger: mockLogger,
      loop: {
        service: {
          resolveLoopName: () => null,
        },
      },
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    } as any)

    // Seed project plans for recent listing
    plansRepo.writeForSession('test-project', 'session-a', '# Session Plan A\n## Auth\n- login flow')
    plansRepo.writeForLoop('test-project', 'loop-a', '# Loop Plan B\n## Dashboard\n- Build widget')
    plansRepo.writeForSession('other-project', 'session-b', '# Other Project\nNot in our scope')
  })

  afterEach(() => {
    db.close()
  })

  test('lists recent project plans', async () => {
    const result = await tools['plan-read'].execute(
      { recent: true },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Recent plans for project')
    expect(result).toContain('test-project')
    expect(result).toContain('session: session-a')
    expect(result).toContain('loop: loop-a')
    expect(result).toContain('# Session Plan A')
    expect(result).toContain('# Loop Plan B')
    expect(result).not.toContain('Other Project')
  })

  test('lists recent project plans respects limit', async () => {
    const result = await tools['plan-read'].execute(
      { recent: true, limit: 1 },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Recent plans for project')
    expect(result).toContain('(1 found)')
  })

  test('searches recent project plans with pattern', async () => {
    const result = await tools['plan-read'].execute(
      { recent: true, pattern: 'auth|login', limit: 10 },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Found')
    expect(result).toContain('match(es)')
    expect(result).toContain('session: session-a')
    expect(result).toContain('- login flow')
    expect(result).not.toContain('loop-a')
    expect(result).not.toContain('Dashboard')
  })

  test('returns invalid regex for recent search', async () => {
    const result = await tools['plan-read'].execute(
      { recent: true, pattern: '[bad' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Invalid regex pattern')
  })

  test('searches recent plans when pattern matches only the title (line 1)', async () => {
    const result = await tools['plan-read'].execute(
      { recent: true, pattern: 'Session Plan A' },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('Found')
    expect(result).toContain('match(es)')
    expect(result).toContain('session: session-a')
    expect(result).toContain('Line 1:')
    expect(result).toContain('# Session Plan A')
    expect(result).not.toContain('loop-a')
  })
})
