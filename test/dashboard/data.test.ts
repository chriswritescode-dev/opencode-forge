import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { openForgeDatabase, closeDatabase } from '../../src/storage/database'
import { collectDashboardData, type DashboardPayload } from '../../src/dashboard/data'
import { createLoopsRepo, type LoopRow } from '../../src/storage'
import { createPlansRepo } from '../../src/storage'
import { createReviewFindingsRepo } from '../../src/storage'
import { createSectionPlansRepo } from '../../src/storage'
import { createLoopSessionUsageRepo, type LoopSessionUsageRow } from '../../src/storage'
import { createLoopEventsRepo, type LoopEventRow } from '../../src/storage'
import { createLoopRunsRepo, type LoopRunRow } from '../../src/storage'

function makeLoopRow(overrides?: Partial<LoopRow>): LoopRow {
  return {
    projectId: 'test-project',
    loopName: 'test-loop',
    status: 'running',
    currentSessionId: 'session-1',
    worktree: false,
    worktreeDir: '/tmp/test',
    worktreeBranch: null,
    projectDir: '/tmp/test',
    maxIterations: 10,
    iteration: 0,
    auditCount: 0,
    errorCount: 0,
    phase: 'coding',
    executionModel: 'claude-sonnet-4-20250514',
    auditorModel: null,
    modelFailed: false,
    sandbox: false,
    sandboxContainer: null,
    startedAt: Date.now(),
    completedAt: null,
    terminationReason: null,
    completionSummary: null,
    workspaceId: null,
    hostSessionId: null,
    currentSectionIndex: 0,
    totalSections: 1,
    finalAuditDone: 0,
    executionVariant: null,
    auditorVariant: null,
    kind: 'plan',
    ...overrides,
  }
}

function makeLoopEventRow(overrides?: Partial<LoopEventRow>): LoopEventRow {
  return {
    projectId: 'test-project',
    loopName: 'test-loop',
    runStartedAt: 1000,
    eventType: 'coding_done',
    outcome: 'section_done',
    verdict: null,
    iteration: 1,
    sectionIndex: 0,
    sessionId: 'session-1',
    role: 'code',
    model: 'claude-sonnet-4-20250514',
    cost: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    messageCount: 5,
    findingsTotal: null,
    findingsBugs: null,
    detail: null,
    createdAt: 1001,
    ...overrides,
  }
}

function makeLoopRunRow(overrides?: Partial<LoopRunRow>): LoopRunRow {
  return {
    projectId: 'test-project',
    loopName: 'test-loop',
    startedAt: 1000,
    completedAt: 2000,
    status: 'completed',
    terminationReason: null,
    loopKind: 'plan',
    executionModel: 'claude-sonnet-4-20250514',
    auditorModel: null,
    executionVariant: null,
    auditorVariant: null,
    iterations: 5,
    auditCount: 2,
    errorCount: 0,
    totalSections: 1,
    sectionRetries: 0,
    cleanAudits: 2,
    dirtyAudits: 0,
    cost: 0.03,
    inputTokens: 300,
    outputTokens: 130,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    messageCount: 13,
    durationMs: 1000,
    createdAt: 1000,
    ...overrides,
  }
}

describe('collectDashboardData', () => {
  let db: Database | null = null
  let dbPath: string

  function createDb(): Database {
    const rand = Math.random().toString(36).slice(2, 10)
    dbPath = `/tmp/forge-dashboard-data-test-${rand}.db`
    return openForgeDatabase(dbPath)
  }

  function closeDb(): void {
    if (db) {
      closeDatabase(db)
      db = null
    }
  }

  beforeEach(() => {
    db = createDb()
  })

  afterEach(() => {
    closeDb()
  })

  // ─── Cycle 1: empty DB ──────────────────────────────────────────────

  test('empty DB returns empty projects and zero totals', () => {
    const payload = collectDashboardData(db!)

    expect(payload.projects).toEqual([])
    expect(payload.totals.projects).toBe(0)
    expect(payload.totals.loops).toBe(0)
    expect(payload.totals.running).toBe(0)
    expect(payload.totals.completed).toBe(0)
    expect(payload.totals.cancelled).toBe(0)
    expect(payload.totals.errored).toBe(0)
    expect(payload.totals.stalled).toBe(0)
    expect(payload.generatedAt).toBeGreaterThan(0)
  })

  // ─── Cycle 2: one project with full data ────────────────────────────

  test('returns a project with running loop, plan, sections, findings, and usage', () => {
    const loopsRepo = createLoopsRepo(db!)
    const plansRepo = createPlansRepo(db!)
    const sectionsRepo = createSectionPlansRepo(db!)
    const findingsRepo = createReviewFindingsRepo(db!)
    const usageRepo = createLoopSessionUsageRepo(db!)

    const projectId = 'p1'
    const loopName = 'l1'

    // Insert loop row
    loopsRepo.insert(
      makeLoopRow({ projectId, loopName }),
      { lastAuditResult: 'audit-result-1' },
    )

    // Write plan
    plansRepo.writeForLoop(projectId, loopName, 'plan-content-1')

    // Insert 2 sections
    sectionsRepo.bulkInsert({
      projectId,
      loopName,
      sections: [
        { index: 0, title: 'Section A', content: 'Content A' },
        { index: 1, title: 'Section B', content: 'Content B' },
      ],
    })

    // Set section statuses explicitly (as per fixture conventions)
    sectionsRepo.setStatus(projectId, loopName, 0, 'completed')
    sectionsRepo.setStatus(projectId, loopName, 1, 'pending')

    // Insert 1 finding
    findingsRepo.write({
      projectId,
      loopName,
      file: 'src/main.ts',
      line: 42,
      severity: 'warning',
      description: 'test finding',
    })

    // Insert usage rows
    usageRepo.upsertSessionUsage({
      projectId,
      loopName,
      sessionId: 'session-1',
      role: 'code',
      model: 'claude-sonnet-4-20250514',
      cost: 0.005,
      inputTokens: 2000,
      outputTokens: 1000,
      reasoningTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 400,
      messageCount: 10,
      capturedAt: Date.now(),
      runStartedAt: 1_700_000_000_000,
    })

    const payload = collectDashboardData(db!)

    expect(payload.projects).toHaveLength(1)
    expect(payload.projects[0].projectId).toBe(projectId)
    expect(payload.projects[0].projectDir).toBe('/tmp/test')
    expect(payload.projects[0].loops).toHaveLength(1)

    const dashLoop = payload.projects[0].loops[0]
    expect(dashLoop.loop.loopName).toBe(loopName)
    expect(dashLoop.loop.status).toBe('running')
    expect(dashLoop.lastAuditResult).toBe('audit-result-1')
    expect(dashLoop.plan).toBe('plan-content-1')
    expect(dashLoop.sections).toHaveLength(2)
    expect(dashLoop.findings).toHaveLength(1)
    expect(dashLoop.usage).not.toBeNull()
    expect(dashLoop.usage!.totalCost).toBe(0.005)

    expect(payload.totals.projects).toBe(1)
    expect(payload.totals.loops).toBe(1)
    expect(payload.totals.running).toBe(1)
  })

  test('computes a human-readable duration from started/completed timestamps', () => {
    const loopsRepo = createLoopsRepo(db!)
    const projectId = 'p1'

    loopsRepo.insert(
      makeLoopRow({
        projectId,
        loopName: 'timed-loop',
        status: 'completed',
        startedAt: 1000,
        completedAt: 1000 + 125_000,
      }),
      { lastAuditResult: null },
    )

    const payload = collectDashboardData(db!)

    expect(payload.projects[0].loops[0].duration).toBe('2m 5s')
  })

  // ─── Cycle 3: running-first ordering ────────────────────────────────

  test('running loop sorts before completed (running-first ordering)', () => {
    const loopsRepo = createLoopsRepo(db!)
    const projectId = 'p1'

    // Insert an older completed loop
    loopsRepo.insert(
      makeLoopRow({
        projectId,
        loopName: 'old-completed',
        currentSessionId: 'session-old',
        status: 'completed',
        startedAt: 100,
        completedAt: 200,
      }),
      { lastAuditResult: null },
    )

    // Insert a newer running loop
    loopsRepo.insert(
      makeLoopRow({
        projectId,
        loopName: 'new-running',
        currentSessionId: 'session-new',
        status: 'running',
        startedAt: 300,
        completedAt: null,
      }),
      { lastAuditResult: null },
    )

    const payload = collectDashboardData(db!)

    expect(payload.projects).toHaveLength(1)
    expect(payload.projects[0].loops).toHaveLength(2)
    expect(payload.projects[0].loops[0].loop.status).toBe('running')
    expect(payload.projects[0].loops[0].loop.loopName).toBe('new-running')
    expect(payload.projects[0].loops[1].loop.status).toBe('completed')
    expect(payload.projects[0].loops[1].loop.loopName).toBe('old-completed')
  })

  // ─── Cycle 3b: non-running group ordering by startedAt desc ──────────

  test('non-running loops are ordered by startedAt desc within their group', () => {
    const loopsRepo = createLoopsRepo(db!)
    const projectId = 'p1'

    // Insert a running loop (newest)
    loopsRepo.insert(
      makeLoopRow({
        projectId,
        loopName: 'running-loop',
        currentSessionId: 'session-run',
        status: 'running',
        startedAt: 300,
        completedAt: null,
      }),
      { lastAuditResult: null },
    )

    // Insert a cancelled loop (newer non-running)
    loopsRepo.insert(
      makeLoopRow({
        projectId,
        loopName: 'cancelled-loop',
        currentSessionId: 'session-cancel',
        status: 'cancelled',
        startedAt: 200,
        completedAt: 250,
      }),
      { lastAuditResult: null },
    )

    // Insert a completed loop (older non-running)
    loopsRepo.insert(
      makeLoopRow({
        projectId,
        loopName: 'completed-loop',
        currentSessionId: 'session-complete',
        status: 'completed',
        startedAt: 100,
        completedAt: 150,
      }),
      { lastAuditResult: null },
    )

    const payload = collectDashboardData(db!)

    expect(payload.projects).toHaveLength(1)
    expect(payload.projects[0].loops).toHaveLength(3)
    // Running first
    expect(payload.projects[0].loops[0].loop.status).toBe('running')
    expect(payload.projects[0].loops[0].loop.loopName).toBe('running-loop')
    // Non-running groups sorted by startedAt desc
    expect(payload.projects[0].loops[1].loop.status).toBe('cancelled')
    expect(payload.projects[0].loops[1].loop.loopName).toBe('cancelled-loop')
    expect(payload.projects[0].loops[2].loop.status).toBe('completed')
    expect(payload.projects[0].loops[2].loop.loopName).toBe('completed-loop')
  })

  // ─── Cycle 4: multiple projects with mixed statuses ─────────────────

  test('aggregates totals across multiple projects with mixed statuses', () => {
    const loopsRepo = createLoopsRepo(db!)

    // Project A: 1 running, 1 completed
    loopsRepo.insert(
      makeLoopRow({
        projectId: 'project-a',
        loopName: 'running-loop',
        currentSessionId: 'session-a1',
        status: 'running',
        startedAt: 500,
      }),
      { lastAuditResult: null },
    )
    loopsRepo.insert(
      makeLoopRow({
        projectId: 'project-a',
        loopName: 'completed-loop',
        currentSessionId: 'session-a2',
        status: 'completed',
        startedAt: 100,
        completedAt: 200,
      }),
      { lastAuditResult: null },
    )

    // Project B: 1 cancelled, 1 errored, 1 stalled
    loopsRepo.insert(
      makeLoopRow({
        projectId: 'project-b',
        loopName: 'cancelled-loop',
        currentSessionId: 'session-b1',
        status: 'cancelled',
        startedAt: 300,
        completedAt: 400,
      }),
      { lastAuditResult: null },
    )
    loopsRepo.insert(
      makeLoopRow({
        projectId: 'project-b',
        loopName: 'errored-loop',
        currentSessionId: 'session-b2',
        status: 'errored',
        startedAt: 200,
        completedAt: 300,
      }),
      { lastAuditResult: null },
    )
    loopsRepo.insert(
      makeLoopRow({
        projectId: 'project-b',
        loopName: 'stalled-loop',
        currentSessionId: 'session-b3',
        status: 'stalled',
        startedAt: 100,
        completedAt: 200,
      }),
      { lastAuditResult: null },
    )

    const payload = collectDashboardData(db!)

    expect(payload.projects).toHaveLength(2)
    expect(payload.totals.projects).toBe(2)
    expect(payload.totals.loops).toBe(5)
    expect(payload.totals.running).toBe(1)
    expect(payload.totals.completed).toBe(1)
    expect(payload.totals.cancelled).toBe(1)
    expect(payload.totals.errored).toBe(1)
    expect(payload.totals.stalled).toBe(1)
  })

  // ─── Cycle 5: loop events and runs payload ──────────────────────────

  test('payload exposes per-loop events (id-ordered) and per-project runs (startedAt desc)', () => {
    const loopsRepo = createLoopsRepo(db!)
    const loopEventsRepo = createLoopEventsRepo(db!)
    const loopRunsRepo = createLoopRunsRepo(db!)

    const projectId = 'p1'
    const startedAt = 5_000

    loopsRepo.insert(
      makeLoopRow({
        projectId,
        loopName: 'l1',
        status: 'running',
        startedAt,
      }),
      { lastAuditResult: null },
    )

    loopEventsRepo.insert(
      makeLoopEventRow({
        projectId,
        loopName: 'l1',
        runStartedAt: startedAt,
        eventType: 'coding_done',
        outcome: 'section_done',
        role: 'code',
        createdAt: startedAt + 1,
      }),
    )
    loopEventsRepo.insert(
      makeLoopEventRow({
        projectId,
        loopName: 'l1',
        runStartedAt: startedAt,
        eventType: 'audit_done',
        outcome: 'clean',
        verdict: 'clean',
        role: 'auditor',
        findingsTotal: 0,
        findingsBugs: 0,
        createdAt: startedAt + 2,
      }),
    )

    loopRunsRepo.upsert(
      makeLoopRunRow({
        projectId,
        loopName: 'l1',
        startedAt,
        completedAt: null,
        status: 'running',
        iterations: 1,
        auditCount: 1,
        cleanAudits: 1,
        durationMs: null,
        createdAt: startedAt,
      }),
    )

    const payload = collectDashboardData(db!)

    expect(payload.projects).toHaveLength(1)
    const dashLoop = payload.projects[0].loops[0]
    expect(dashLoop.events).toHaveLength(2)
    expect(dashLoop.events[0].eventType).toBe('coding_done')
    expect(dashLoop.events[1].eventType).toBe('audit_done')

    const runs = payload.projects[0].runs
    expect(runs).toHaveLength(1)
    expect(runs[0].loopName).toBe('l1')
    expect(runs[0].startedAt).toBe(startedAt)
  })

  test('runs include swept loops whose loops row was deleted, with empty loops array', () => {
    const loopsRepo = createLoopsRepo(db!)
    const loopRunsRepo = createLoopRunsRepo(db!)

    const projectId = 'p2'
    const startedAt = 7_000

    // Seed the loops row, then drop it to simulate a swept loop whose metrics survived.
    loopsRepo.insert(
      makeLoopRow({
        projectId,
        loopName: 'swept-loop',
        status: 'completed',
        startedAt,
        completedAt: startedAt + 100,
      }),
      { lastAuditResult: null },
    )
    loopsRepo.delete(projectId, 'swept-loop')

    loopRunsRepo.upsert(
      makeLoopRunRow({
        projectId,
        loopName: 'swept-loop',
        startedAt,
        completedAt: startedAt + 100,
        status: 'completed',
        terminationReason: 'max_iterations',
        iterations: 10,
        auditCount: 5,
        cleanAudits: 5,
        durationMs: 100,
        createdAt: startedAt,
      }),
    )

    const payload = collectDashboardData(db!)

    // Project surfaces via loop_runs even though no live loops remain.
    expect(payload.projects).toHaveLength(1)
    expect(payload.projects[0].projectId).toBe(projectId)
    expect(payload.projects[0].projectDir).toBeNull()
    expect(payload.projects[0].loops).toEqual([])
    expect(payload.projects[0].runs).toHaveLength(1)
    expect(payload.projects[0].runs[0].loopName).toBe('swept-loop')

    // Swept-only project contributes no loop status totals.
    expect(payload.totals.projects).toBe(1)
    expect(payload.totals.loops).toBe(0)
    expect(payload.totals.completed).toBe(0)
  })

  test('project ids are the union of loops and loop_runs, de-duplicated and ordered', () => {
    const loopsRepo = createLoopsRepo(db!)
    const loopRunsRepo = createLoopRunsRepo(db!)

    loopsRepo.insert(
      makeLoopRow({
        projectId: 'alpha',
        loopName: 'live',
        status: 'running',
        startedAt: 900,
      }),
      { lastAuditResult: null },
    )
    loopRunsRepo.upsert(
      makeLoopRunRow({
        projectId: 'beta',
        loopName: 'swept',
        startedAt: 100,
        completedAt: 200,
      }),
    )

    const payload = collectDashboardData(db!)

    expect(payload.projects.map((p) => p.projectId)).toEqual(['alpha', 'beta'])
    expect(payload.totals.projects).toBe(2)
    expect(payload.totals.loops).toBe(1)
    expect(payload.totals.running).toBe(1)
  })
})
