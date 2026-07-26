import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { createPlanAuthoringTools } from '../../src/tools/plan-authoring'
import { createPlanTools } from '../../src/tools/plan-kv'
import { createLoopService } from '../../src/loop/service'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { openForgeDatabase } from '../../src/storage/database'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Logger } from '../../src/types'
import type { ToolContext } from '../../src/tools/types'

const TEST_DIR = '/tmp/opencode-plan-write-test-' + Date.now()

function createTestDb(): Database {
  return openForgeDatabase(join(tmpdir(), `forge-test-${randomUUID()}.db`))
}

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

function insertRunningLoop(
  loopsRepo: ReturnType<typeof createLoopsRepo>,
  loopName: string,
  sessionId: string,
) {
  loopsRepo.insert(
    {
      projectId: 'test-project',
      loopName,
      status: 'running',
      currentSessionId: sessionId,
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
    },
    { lastAuditResult: null },
  )
}

function createToolContext(db: Database) {
  const loopsRepo = createLoopsRepo(db)
  const plansRepo = createPlansRepo(db)
  const reviewFindingsRepo = createReviewFindingsRepo(db)
  const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'test-project', mockLogger)
  return {
    ctx: {
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      projectId: 'test-project',
      logger: mockLogger,
      loop: { service: loopService },
      directory: TEST_DIR,
    } as unknown as ToolContext,
    plansRepo,
    loopsRepo,
  }
}

describe('plan-write', () => {
  let db: Database
  let tools: ReturnType<typeof createPlanAuthoringTools>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let loopsRepo: ReturnType<typeof createLoopsRepo>

  beforeEach(() => {
    db = createTestDb()
    const env = createToolContext(db)
    tools = createPlanAuthoringTools(env.ctx)
    plansRepo = env.plansRepo
    loopsRepo = env.loopsRepo
  })

  afterEach(() => {
    db.close()
  })

  test('writes normalized plan content to the session row', async () => {
    const content = `# Plan

Loop Name: my-loop

<!-- forge-section -->
## Phase 1
- do one

<!-- forge-section -->
## Phase 2
- do two
`
    const result = await tools['plan-write'].execute(
      { content },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('Plan stored:')
    expect(result).toContain('Sections (2):')

    const row = plansRepo.getForSession('test-project', 'sess-1')
    expect(row).not.toBeNull()
    expect(row!.content).toBe(content.trim())
    expect(row!.content).not.toContain('<!-- forge-plan:start -->')
    expect(row!.content).not.toContain('<!-- forge-plan:end -->')
  })

  test('strips outer forge-plan markers before storing', async () => {
    const body = `# Plan

<!-- forge-section -->
## Phase 1
- do one
`
    const content = `<!-- forge-plan:start -->
${body}
<!-- forge-plan:end -->`

    const result = await tools['plan-write'].execute(
      { content },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('Plan stored:')
    const row = plansRepo.getForSession('test-project', 'sess-1')
    expect(row!.content).toBe(body.trim())
    expect(row!.content).not.toContain('forge-plan:')
  })

  test('append: true concatenates existing content with two newlines', async () => {
    const existing = `# Plan

<!-- forge-section -->
## Phase 1
- do one`
    plansRepo.writeForSession('test-project', 'sess-1', existing)

    const fragment = `<!-- forge-section -->
## Phase 2
- do two`

    const result = await tools['plan-write'].execute(
      { content: fragment, append: true },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('Plan stored:')
    const row = plansRepo.getForSession('test-project', 'sess-1')
    expect(row!.content).toBe(`${existing}\n\n${fragment.trim()}`)
  })

  test('append: true creates the row when none exists', async () => {
    const fragment = `# Fresh Plan

<!-- forge-section -->
## Phase 1
- do one`

    const result = await tools['plan-write'].execute(
      { content: fragment, append: true },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('Plan stored:')
    const row = plansRepo.getForSession('test-project', 'sess-1')
    expect(row).not.toBeNull()
    expect(row!.content).toBe(fragment.trim())
  })

  test('from a running-loop session performs no write and names the loop', async () => {
    plansRepo.writeForSession('test-project', 'sess-1', 'pre-existing content')
    insertRunningLoop(loopsRepo, 'test-loop', 'sess-1')

    const result = await tools['plan-write'].execute(
      { content: '# attempt\n' },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('Cannot modify the plan from an active loop session')
    expect(result).toContain('test-loop')
    expect(result).toContain('plan-adjust')

    const row = plansRepo.getForSession('test-project', 'sess-1')
    expect(row!.content).toBe('pre-existing content')
  })

  test('unbalanced plan marker performs no write and returns failure message', async () => {
    const content = `<!-- forge-plan:start -->
# Plan
- no end marker`

    const result = await tools['plan-write'].execute(
      { content },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toBe(
      'plan-write failed: content contains an unbalanced <!-- forge-plan:start --> / <!-- forge-plan:end --> marker.',
    )
    expect(plansRepo.getForSession('test-project', 'sess-1')).toBeNull()
  })

  test('empty content returns a failure message and does not write', async () => {
    const result = await tools['plan-write'].execute(
      { content: '   ' },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toBe('plan-write failed: content is empty.')
    expect(plansRepo.getForSession('test-project', 'sess-1')).toBeNull()
  })
})

describe('plan-edit', () => {
  let db: Database
  let tools: ReturnType<typeof createPlanAuthoringTools>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let loopsRepo: ReturnType<typeof createLoopsRepo>

  beforeEach(() => {
    db = createTestDb()
    const env = createToolContext(db)
    tools = createPlanAuthoringTools(env.ctx)
    plansRepo = env.plansRepo
    loopsRepo = env.loopsRepo
  })

  afterEach(() => {
    db.close()
  })

  const BASE_PLAN = `# Plan

<!-- forge-section -->
## Phase 1
- do one

<!-- forge-section -->
## Phase 2
- do two
`

  test('a unique-match edit rewrites only the matched span and leaves the rest byte-identical', async () => {
    plansRepo.writeForSession('test-project', 'sess-1', BASE_PLAN)

    const result = await tools['plan-edit'].execute(
      { oldString: '- do one', newString: '- do one (revised)' },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('Replaced 1 occurrence(s).')
    expect(result).toContain('Plan stored:')

    const row = plansRepo.getForSession('test-project', 'sess-1')
    expect(row!.content).toBe(BASE_PLAN.replace('- do one', '- do one (revised)'))
    // Untouched portions remain byte-identical.
    expect(row!.content).toContain('## Phase 2')
    expect(row!.content).toContain('- do two')
  })

  test('a 3-occurrence oldString without replaceAll performs no write and names 3', async () => {
    const content = `# Plan\n\nline\nline\nline\n`
    plansRepo.writeForSession('test-project', 'sess-1', content)
    const before = plansRepo.getForSession('test-project', 'sess-1')!

    const result = await tools['plan-edit'].execute(
      { oldString: 'line', newString: 'replaced' },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toBe(
      'plan-edit failed: found 3 matches for oldString. Add surrounding context to make it unique, or set replaceAll: true.',
    )
    const after = plansRepo.getForSession('test-project', 'sess-1')!
    expect(after.content).toBe(before.content)
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  test('the same oldString with replaceAll: true replaces all 3 and the report leads with Replaced 3 occurrence(s).', async () => {
    const content = `# Plan\n\nline\nline\nline\n`
    plansRepo.writeForSession('test-project', 'sess-1', content)

    const result = await tools['plan-edit'].execute(
      { oldString: 'line', newString: 'replaced', replaceAll: true },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toMatch(/^Replaced 3 occurrence\(s\)\./)
    expect(result).toContain('Plan stored:')
    const row = plansRepo.getForSession('test-project', 'sess-1')
    expect(row!.content).toBe('# Plan\n\nreplaced\nreplaced\nreplaced\n')
  })

  test('oldString containing regex metacharacters is matched literally', async () => {
    const content = `# Plan

[Phase 1] (a|b) $x is special
`
    plansRepo.writeForSession('test-project', 'sess-1', content)

    const result = await tools['plan-edit'].execute(
      { oldString: '[Phase 1] (a|b) $x', newString: '[Phase 2] (c) $y' },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('Replaced 1 occurrence(s).')
    const row = plansRepo.getForSession('test-project', 'sess-1')
    expect(row!.content).toBe(content.replace('[Phase 1] (a|b) $x', '[Phase 2] (c) $y'))
  })

  test('editing with no stored plan performs no write and returns the corresponding message', async () => {
    const result = await tools['plan-edit'].execute(
      { oldString: 'foo', newString: 'bar' },
      { sessionID: 'sess-empty', directory: TEST_DIR } as any,
    )

    expect(result).toBe('plan-edit failed: no plan stored for this session. Use plan-write to create it first.')
    expect(plansRepo.getForSession('test-project', 'sess-empty')).toBeNull()
  })

  test('editing with oldString === newString performs no write and returns the corresponding message', async () => {
    plansRepo.writeForSession('test-project', 'sess-1', BASE_PLAN)
    const before = plansRepo.getForSession('test-project', 'sess-1')!

    const result = await tools['plan-edit'].execute(
      { oldString: '## Phase 1', newString: '## Phase 1' },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toBe('plan-edit failed: oldString and newString are identical.')
    const after = plansRepo.getForSession('test-project', 'sess-1')!
    expect(after.content).toBe(before.content)
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  test('a zero-match edit performs no write and leaves content and updatedAt untouched', async () => {
    plansRepo.writeForSession('test-project', 'sess-1', BASE_PLAN)
    const before = plansRepo.getForSession('test-project', 'sess-1')!

    const result = await tools['plan-edit'].execute(
      { oldString: 'no such text here', newString: 'whatever' },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toBe(
      'plan-edit failed: oldString not found in the stored plan. Use plan-read to inspect the current text; whitespace and indentation must match exactly.',
    )
    const after = plansRepo.getForSession('test-project', 'sess-1')!
    expect(after.content).toBe(before.content)
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  test('editing from a running-loop session performs no write and returns the plan-adjust guidance', async () => {
    plansRepo.writeForSession('test-project', 'sess-1', BASE_PLAN)
    insertRunningLoop(loopsRepo, 'test-loop', 'sess-1')

    const result = await tools['plan-edit'].execute(
      { oldString: '## Phase 1', newString: '## Phase 1 (edited)' },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('Cannot modify the plan from an active loop session')
    expect(result).toContain('test-loop')
    expect(result).toContain('plan-adjust')
    expect(plansRepo.getForSession('test-project', 'sess-1')!.content).toBe(BASE_PLAN)
  })

  test('an edit that adds a forge-section marker is reflected in the returned section count', async () => {
    const single = `# Plan

<!-- forge-section -->
## Phase 1
- do one
`
    plansRepo.writeForSession('test-project', 'sess-1', single)

    const result = await tools['plan-edit'].execute(
      {
        oldString: '- do one',
        newString: '- do one\n\n<!-- forge-section -->\n## Phase 2\n- do two',
      },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('Sections (2):')
    expect(result).toContain('Phase 1')
    expect(result).toContain('Phase 2')
    const row = plansRepo.getForSession('test-project', 'sess-1')
    expect(row!.content).toContain('## Phase 2')
  })

  test('an edit whose result would be empty or whitespace-only performs no write', async () => {
    const content = '# The entire plan'
    plansRepo.writeForSession('test-project', 'sess-1', content)
    const before = plansRepo.getForSession('test-project', 'sess-1')!

    const result = await tools['plan-edit'].execute(
      { oldString: content, newString: '   ' },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('plan-edit failed: replacement would leave the plan empty.')
    const after = plansRepo.getForSession('test-project', 'sess-1')!
    expect(after.content).toBe(before.content)
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  test('deleting an ordinary substring to leave non-whitespace content still writes', async () => {
    const content = `# Plan

Line A
Line B`
    plansRepo.writeForSession('test-project', 'sess-1', content)

    const result = await tools['plan-edit'].execute(
      { oldString: 'Line B', newString: '' },
      { sessionID: 'sess-1', directory: TEST_DIR } as any,
    )

    expect(result).toContain('Replaced 1 occurrence(s).')
    const row = plansRepo.getForSession('test-project', 'sess-1')
    expect(row!.content).toBe('# Plan\n\nLine A\n')
  })
})

describe('createTools registration', () => {
  test('plan-write is registered alongside plan-read', async () => {
    const db = createTestDb()
    try {
      const env = createToolContext(db)
      // Simulate the full createTools spread by combining plan-kv and plan-authoring
      const tools = { ...createPlanTools(env.ctx), ...createPlanAuthoringTools(env.ctx) }
      expect(tools['plan-read']).toBeDefined()
      expect(tools['plan-write']).toBeDefined()
      expect(tools['plan-edit']).toBeDefined()
    } finally {
      db.close()
    }
  })
})
