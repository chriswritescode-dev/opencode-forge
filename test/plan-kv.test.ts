import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createKvService } from '../src/services/kv'
import { createPlanTools } from '../src/tools/plan-kv'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-manager-plan-kv-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_kv (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_project_kv_expires_at ON project_kv(expires_at)`)
  return db
}

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('plan-write', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db, mockLogger)
    tools = createPlanTools({
      kvService,
      projectId: 'test-project',
      logger: mockLogger,
      loopService: { resolveWorktreeName: () => null } as any,
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    })
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

    const stored = kvService.get('test-project', 'plan:test-session')
    expect(stored).toBe(planContent)
  })

  test('overwrites existing plan', async () => {
    const initialPlan = '# Old Plan\n\nContent here'
    kvService.set('test-project', 'plan:test-session', initialPlan)

    const newPlan = '# New Plan\n\nNew content'
    await tools['plan-write'].execute(
      { content: newPlan },
      { sessionID: 'test-session', directory: TEST_DIR } as any
    )

    const stored = kvService.get('test-project', 'plan:test-session')
    expect(stored).toBe(newPlan)
  })
})

describe('plan-edit', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db, mockLogger)
    tools = createPlanTools({
      kvService,
      projectId: 'test-project',
      logger: mockLogger,
      loopService: { resolveWorktreeName: () => null } as any,
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    })

    // Seed with initial plan
    const initialPlan = `# Implementation Plan

## Phase 1: Setup
- Create directory structure
- Initialize configuration

## Phase 2: Implementation
- Write core logic
- Add tests
`
    kvService.set('test-project', 'plan:test-session', initialPlan)
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

    const stored = kvService.get<string>('test-project', 'plan:test-session')
    expect(stored).toContain('- Create directory structure')
    expect(stored).toContain('- Set up TypeScript')
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
    kvService.set('test-project', 'plan:test-session', duplicatePlan)

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
    kvService.delete('test-project', 'plan:test-session')

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
  let kvService: ReturnType<typeof createKvService>
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db, mockLogger)
    tools = createPlanTools({
      kvService,
      projectId: 'test-project',
      logger: mockLogger,
      loopService: { resolveWorktreeName: () => null } as any,
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    })

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
    kvService.set('test-project', 'plan:test-session', planContent)
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
    kvService.delete('test-project', 'plan:test-session')

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
})

describe('plan-read with loop session', () => {
  let db: Database
  let kvService: ReturnType<typeof createKvService>
  let tools: ReturnType<typeof createPlanTools>

  beforeEach(() => {
    db = createTestDb()
    kvService = createKvService(db, mockLogger)
    tools = createPlanTools({
      kvService,
      projectId: 'test-project',
      logger: mockLogger,
      loopService: {
        resolveWorktreeName: (sessionID: string) =>
          sessionID === 'loop-session-123' ? 'my-loop' : null,
      } as any,
      directory: TEST_DIR,
      sessionID: 'test-session',
      config: {} as any,
      sandboxManager: {} as any,
    })

    kvService.set('test-project', 'plan:my-loop', '# Loop Plan\n\n## Phase 1\n- Do the thing')
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
    kvService.set('test-project', 'plan:non-loop-session', '# Regular Plan')

    const result = await tools['plan-read'].execute(
      {},
      { sessionID: 'non-loop-session', directory: TEST_DIR } as any
    )

    expect(result).toContain('# Regular Plan')
  })

  test('plan-write stores under worktree name for loop sessions', async () => {
    await tools['plan-write'].execute(
      { content: '# Updated Loop Plan' },
      { sessionID: 'loop-session-123', directory: TEST_DIR } as any
    )

    const stored = kvService.get('test-project', 'plan:my-loop')
    expect(stored).toBe('# Updated Loop Plan')
  })

  test('plan-edit edits plan under worktree name for loop sessions', async () => {
    await tools['plan-edit'].execute(
      { old_string: '- Do the thing', new_string: '- Do the updated thing' },
      { sessionID: 'loop-session-123', directory: TEST_DIR } as any
    )

    const stored = kvService.get<string>('test-project', 'plan:my-loop')
    expect(stored).toContain('- Do the updated thing')
  })
})
