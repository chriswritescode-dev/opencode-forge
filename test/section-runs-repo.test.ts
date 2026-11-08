import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { createLoopsRepo, type LoopRow } from '../src/storage/repos/loops-repo'
import { createSectionRunsRepo } from '../src/storage/repos/section-runs-repo'
import { createTestDb, type TestDb } from './helpers/test-db'

describe('SectionRunsRepo', () => {
  let db: Database
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let sectionRuns: ReturnType<typeof createSectionRunsRepo>
  let testDb: TestDb

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
    loopsRepo = createLoopsRepo(db)
    sectionRuns = createSectionRunsRepo(db)
  })

  afterEach(() => {
    testDb.cleanup()
  })

  const loopRow = (overrides: Partial<LoopRow> = {}): LoopRow => ({
    projectId: 'proj',
    loopName: 'loop',
    status: 'running',
    currentSessionId: 'sess-1',
    worktree: false,
    worktreeDir: '/tmp/wt',
    worktreeBranch: null,
    projectDir: '/tmp/proj',
    maxIterations: 10,
    iteration: 1,
    auditCount: 0,
    errorCount: 0,
    phase: 'coding',
    executionModel: null,
    auditorModel: null,
    modelFailed: false,
    sandbox: false,
    sandboxContainer: null,
    startedAt: 1000,
    completedAt: null,
    terminationReason: null,
    completionSummary: null,
    workspaceId: null,
    hostSessionId: null,
    currentSectionIndex: 0,
    totalSections: 0,
    executionVariant: null,
    auditorVariant: null,
    baseCommit: null,
    standbySessionId: null,
    sectionRunKind: 'plan',
    sectionId: '',
    sectionRunKey: 'plan',
    ...overrides,
  })

  const seedSectionPlans = () => {
    db.run('PRAGMA foreign_keys=OFF')
    db.prepare(`
      INSERT INTO section_plans (project_id, loop_name, section_index, section_id, title, content, created_at)
      VALUES ('proj', 'loop', ?, ?, ?, ?, 1000)
    `).run(0, 'alpha', 'Alpha', 'Alpha content')
    db.prepare(`
      INSERT INTO section_plans (project_id, loop_name, section_index, section_id, title, content, created_at)
      VALUES ('proj', 'loop', ?, ?, ?, ?, 1000)
    `).run(1, 'beta', 'Beta', 'Beta content')
    db.run('PRAGMA foreign_keys=ON')
  }

  const primaryRun = () => sectionRuns.listActive('proj', 'loop')[0]

  const activeRunCount = (): number =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM section_runs WHERE project_id = 'proj' AND loop_name = 'loop' AND status = 'active'",
        )
        .get() as { c: number }
    ).c

  test('insert creates exactly one active plan run and getBySessionId resolves through it', () => {
    loopsRepo.insert(loopRow(), { lastAuditResult: null })

    const runs = sectionRuns.listForLoop('proj', 'loop')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      kind: 'plan',
      sectionId: '',
      sectionRunKey: 'plan',
      phase: 'coding',
      sessionId: 'sess-1',
      status: 'active',
    })
    expect(loopsRepo.getBySessionId('proj', 'sess-1')?.loopName).toBe('loop')

    const retrieved = loopsRepo.get('proj', 'loop')
    expect(retrieved!.sectionRunKind).toBe('plan')
    expect(retrieved!.sectionRunKey).toBe('plan')
  })

  test('moving sections finishes the old run and activates the next one carrying session, standby and phase', () => {
    seedSectionPlans()
    loopsRepo.insert(
      loopRow({ totalSections: 2, currentSectionIndex: 0, phase: 'auditing', standbySessionId: 'standby-1' }),
      { lastAuditResult: null },
    )

    expect(primaryRun()?.sectionRunKey).toBe('section:alpha')

    loopsRepo.setCurrentSectionIndex('proj', 'loop', 1)

    const runs = sectionRuns.listForLoop('proj', 'loop')
    expect(runs).toHaveLength(2)
    const alpha = runs.find((run) => run.sectionId === 'alpha')!
    const beta = runs.find((run) => run.sectionId === 'beta')!
    expect(alpha.status).toBe('finished')
    expect(alpha.finishedAt).not.toBeNull()
    expect(beta).toMatchObject({
      status: 'active',
      sessionId: 'sess-1',
      standbySessionId: 'standby-1',
      phase: 'auditing',
      sectionIndex: 1,
    })

    const retrieved = loopsRepo.get('proj', 'loop')!
    expect(retrieved.sectionId).toBe('beta')
    expect(retrieved.sectionRunKey).toBe('section:beta')
    expect(retrieved.currentSectionIndex).toBe(1)
    expect(activeRunCount()).toBe(1)
  })

  test('entering post_action activates the post_action run with the same session', () => {
    loopsRepo.insert(loopRow({ standbySessionId: 'standby-1' }), { lastAuditResult: null })

    loopsRepo.updatePhase('proj', 'loop', 'post_action')

    const runs = sectionRuns.listForLoop('proj', 'loop')
    expect(runs).toHaveLength(2)
    expect(runs.find((run) => run.kind === 'plan')?.status).toBe('finished')
    const active = runs.find((run) => run.status === 'active')!
    expect(active).toMatchObject({
      kind: 'post_action',
      sectionId: '',
      sessionId: 'sess-1',
      standbySessionId: 'standby-1',
      phase: 'post_action',
    })

    const retrieved = loopsRepo.get('proj', 'loop')!
    expect(retrieved.sectionRunKey).toBe('post_action')
    expect(retrieved.phase).toBe('post_action')
    expect(activeRunCount()).toBe(1)
  })

  test('restart re-activates the run for the restart phase and section with no standby', () => {
    seedSectionPlans()
    loopsRepo.insert(
      loopRow({ totalSections: 2, currentSectionIndex: 0, standbySessionId: 'standby-1' }),
      { lastAuditResult: null },
    )

    loopsRepo.restart('proj', 'loop', {
      sessionId: 'sess-2',
      phase: 'coding',
      iteration: 2,
      auditCount: 0,
      sandbox: false,
      sandboxContainer: null,
      workspaceId: null,
      currentSectionIndex: 1,
      totalSections: 2,
      startedAt: Date.now(),
      auditorModel: null,
    })

    const active = primaryRun()!
    expect(active).toMatchObject({
      sectionId: 'beta',
      sectionIndex: 1,
      sessionId: 'sess-2',
      standbySessionId: null,
      phase: 'coding',
    })
    expect(activeRunCount()).toBe(1)

    const retrieved = loopsRepo.get('proj', 'loop')!
    expect(retrieved.currentSessionId).toBe('sess-2')
    expect(retrieved.sectionId).toBe('beta')
  })

  test('restore finishes the displaced run at restore time, never before it started', () => {
    seedSectionPlans()
    loopsRepo.insert(loopRow({ totalSections: 2, currentSectionIndex: 0 }), { lastAuditResult: null })

    loopsRepo.restart('proj', 'loop', {
      sessionId: 'sess-2',
      phase: 'coding',
      iteration: 2,
      auditCount: 0,
      sandbox: false,
      sandboxContainer: null,
      workspaceId: null,
      currentSectionIndex: 1,
      totalSections: 2,
      startedAt: 2000,
      auditorModel: null,
    })

    loopsRepo.restore(loopRow({ totalSections: 2, currentSectionIndex: 0 }), { lastAuditResult: null })

    const displaced = sectionRuns.listForLoop('proj', 'loop').find((run) => run.sectionId === 'beta')!
    expect(displaced.status).toBe('finished')
    expect(displaced.startedAt).toBe(2000)
    expect(displaced.finishedAt).not.toBeNull()
    expect(displaced.finishedAt!).toBeGreaterThanOrEqual(displaced.startedAt)
    expect(primaryRun()?.sectionId).toBe('alpha')
  })

  test('terminate clears the active run standby and keeps the run active', () => {
    loopsRepo.insert(loopRow({ standbySessionId: 'standby-1' }), { lastAuditResult: null })

    loopsRepo.terminate('proj', 'loop', {
      status: 'completed',
      reason: 'done',
      completedAt: Date.now(),
    })

    const runs = sectionRuns.listForLoop('proj', 'loop')
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('active')
    expect(runs[0].standbySessionId).toBeNull()

    const retrieved = loopsRepo.get('proj', 'loop')!
    expect(retrieved.status).toBe('completed')
    expect(retrieved.standbySessionId).toBeNull()
  })

  test('serial moves keep exactly one active run', () => {
    seedSectionPlans()
    loopsRepo.insert(loopRow({ totalSections: 2, currentSectionIndex: 0 }), { lastAuditResult: null })
    expect(activeRunCount()).toBe(1)

    loopsRepo.setCurrentSectionIndex('proj', 'loop', 1)
    expect(activeRunCount()).toBe(1)
    expect(primaryRun()?.sectionRunKey).toBe('section:beta')

    loopsRepo.setCurrentSectionIndex('proj', 'loop', 0)
    expect(activeRunCount()).toBe(1)
    expect(primaryRun()?.sectionRunKey).toBe('section:alpha')

    loopsRepo.updatePhase('proj', 'loop', 'post_action')
    expect(activeRunCount()).toBe(1)
    expect(primaryRun()?.kind).toBe('post_action')

    loopsRepo.updatePhase('proj', 'loop', 'coding')
    expect(activeRunCount()).toBe(1)
    expect(primaryRun()?.sectionRunKey).toBe('section:alpha')
  })

  test('a non-exclusive activation leaves other active runs alone and resolves each by key or session', () => {
    seedSectionPlans()
    loopsRepo.insert(loopRow({ totalSections: 2, currentSectionIndex: 0 }), { lastAuditResult: null })

    sectionRuns.activate(
      'proj',
      'loop',
      { kind: 'section', sectionId: 'beta', sectionIndex: 1 },
      { sessionId: 'sess-parallel', phase: 'coding', standbySessionId: null },
      { exclusive: false },
    )

    expect(activeRunCount()).toBe(2)
    expect(sectionRuns.listActive('proj', 'loop').map((run) => run.sectionId)).toEqual(['alpha', 'beta'])
    expect(sectionRuns.get('proj', 'loop', 'section:beta')?.sessionId).toBe('sess-parallel')
    expect(sectionRuns.getBySession('proj', 'sess-parallel')?.sectionId).toBe('beta')
    expect(loopsRepo.getBySessionId('proj', 'sess-parallel')?.loopName).toBe('loop')
    expect(loopsRepo.getBySessionId('proj', 'sess-1')?.loopName).toBe('loop')
    expect(loopsRepo.get('proj', 'loop')!.sectionId).toBe('alpha')

    loopsRepo.incrementError('proj', 'loop', 'section:beta')
    expect(sectionRuns.get('proj', 'loop', 'section:alpha')!.errorCount).toBe(0)
    expect(sectionRuns.get('proj', 'loop', 'section:beta')!.errorCount).toBe(1)

    expect(sectionRuns.advanceAuditorFallbackIndex('proj', 'loop', 'section:beta', 0)).toBe(true)
    expect(sectionRuns.get('proj', 'loop', 'section:beta')!.auditorFallbackIndex).toBe(1)
    expect(sectionRuns.get('proj', 'loop', 'section:alpha')!.auditorFallbackIndex).toBe(0)
    expect(sectionRuns.advanceAuditorFallbackIndex('proj', 'loop', 'section:beta', 0)).toBe(false)
  })
})
