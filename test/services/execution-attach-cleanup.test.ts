import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { buildExecutionDeps } from '../helpers/loop-fixtures'
import { createTestDb } from '../helpers/test-db'

const PROJECT_ID = 'test-project'

describe('attachLoopToSession', () => {
  let testDb: ReturnType<typeof createTestDb>
  let db: ReturnType<typeof createTestDb>['db']

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
  })

  afterEach(() => {
    testDb.cleanup()
  })

  test('attachLoopToSession purges orphaned per-loop rows even when no loops row exists', async () => {
    const { deps, sectionPlansRepo, plansRepo, reviewFindingsRepo } = buildExecutionDeps(db)

    const LOOP_NAME = 'orphan-loop'

    // Seed orphaned section_plans for the loop (no loops row exists)
    db.exec('PRAGMA foreign_keys=OFF')
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      sections: [
        { index: 0, title: 'Stale section', content: '# Stale\n\nStale content.' },
      ],
    })
    sectionPlansRepo.setStatus(PROJECT_ID, LOOP_NAME, 0, 'in_progress')

    // Seed orphaned plan for the loop
    plansRepo.writeForLoop(PROJECT_ID, LOOP_NAME, 'STALE_PLAN_CONTENT')

    // Seed orphaned review findings for the loop
    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      file: 'a.ts',
      line: 1,
      severity: 'bug' as const,
      description: 'stale finding',
    })
    db.exec('PRAGMA foreign_keys=ON')

    // Verify seed data is present before attach
    expect(sectionPlansRepo.count(PROJECT_ID, LOOP_NAME)).toBe(1)
    expect(plansRepo.getForLoop(PROJECT_ID, LOOP_NAME)).not.toBeNull()
    expect(reviewFindingsRepo.listByLoopName(PROJECT_ID, LOOP_NAME).length).toBeGreaterThan(0)

    // Confirm no loops row exists for orphan-loop (simulating orphan state)
    const existingLoop = deps.loopsRepo.get(PROJECT_ID, LOOP_NAME)
    expect(existingLoop).toBeNull()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_fresh',
        workspaceId: 'ws_fresh',
        worktreeDir: '/tmp/wt/fresh',
        loopName: LOOP_NAME,
        displayName: 'Orphan Loop',
        executionName: LOOP_NAME,
        maxIterations: 50,
        sandboxEnabled: false,
        planText: 'NEW_PLAN',
        startWatchdog: false,
      },
    )

    // Attach should succeed (no existing running loop)
    expect(result.ok).toBe(true)

    // --- Assertions that MUST fail today ---
    // Today: no purge logic exists, so the orphaned rows remain.
    // After Phase 6: these should pass once defensive purge is added.
    expect(sectionPlansRepo.count(PROJECT_ID, LOOP_NAME)).toBe(0)
    // Plan row is rewritten by setState from the new plan text ('NEW_PLAN')
    const planAfterAttach = plansRepo.getForLoop(PROJECT_ID, LOOP_NAME)
    expect(planAfterAttach).not.toBeNull()
    expect(planAfterAttach!.content).toBe('NEW_PLAN')
    expect(reviewFindingsRepo.listByLoopName(PROJECT_ID, LOOP_NAME)).toEqual([])
  })
})
