import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { openForgeDatabase, closeDatabase } from '../../src/storage/database'
import { collectDashboardData, type DashboardPayload, type DashboardScope } from '../../src/dashboard/data'
import { createLoopsRepo, type LoopRow } from '../../src/storage'
import { createPlansRepo } from '../../src/storage'
import { createReviewFindingsRepo } from '../../src/storage'
import { createSectionPlansRepo } from '../../src/storage'
import { createLoopSessionUsageRepo, type LoopSessionUsageRow } from '../../src/storage'
import { createLoopTransitionsRepo } from '../../src/storage'
import { createPlanAmendmentsRepo } from '../../src/storage'
import { createFeatureGroupsRepo } from '../../src/storage'

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

  test('empty DB returns empty projects', () => {
    const payload = collectDashboardData(db!)

    expect(payload.projects).toEqual([])
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
    })

    const payload = collectDashboardData(db!, { projectId, loopName })

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
    expect(dashLoop.usage!.byRole.code).toEqual({
      cost: 0.005,
      inputTokens: 2000,
      outputTokens: 1000,
      reasoningTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 400,
      messageCount: 10,
    })
    expect(dashLoop.usage!.byRole.auditor).toBeUndefined()

    expect(payload.projects).toHaveLength(1)
    expect(payload.projects[0].loops).toHaveLength(1)
    expect(payload.projects[0].loops[0].loop.status).toBe('running')
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

  test('a loop with goal in loop_large_fields exposes goal on the dashboard loop', () => {
    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'goal-loop', kind: 'goal' }),
      { lastAuditResult: null, goal: 'Ship the tabs refactor' },
    )
    const payload = collectDashboardData(db!, { projectId: 'p1', loopName: 'goal-loop' })
    expect(payload.projects[0].loops[0].goal).toBe('Ship the tabs refactor')
  })

  test('a loop with no large-fields goal exposes goal as null', () => {
    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'no-goal' }),
      { lastAuditResult: null, goal: null },
    )
    const payload = collectDashboardData(db!, { projectId: 'p1', loopName: 'no-goal' })
    expect(payload.projects[0].loops[0].goal).toBeNull()
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

  test('groups loops under their project across multiple projects with mixed statuses', () => {
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
    expect(payload.projects.map(p => p.projectId)).toEqual(['project-a', 'project-b'])
    const statusesByProject = payload.projects.map(p => p.loops.map(dl => dl.loop.status).sort())
    expect(statusesByProject).toEqual([
      ['completed', 'running'],
      ['cancelled', 'errored', 'stalled'],
    ])
  })

  // ─── Cycle 5: feature groups ──────────────────────────────────────────

  test('a project with no groups exposes groups: []', () => {
    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'l1' }),
      { lastAuditResult: null },
    )
    const payload = collectDashboardData(db!)
    expect(payload.projects).toHaveLength(1)
    expect(payload.projects[0].groups).toEqual([])
  })

  test('a group with three features exposes them ordered by featureIndex', () => {
    const loopsRepo = createLoopsRepo(db!)
    const groupsRepo = createFeatureGroupsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'l1' }),
      { lastAuditResult: null },
    )
    groupsRepo.createGroup({
      projectId: 'p1',
      groupId: 'g-1',
      title: 'Group One',
      status: 'running',
      maxConcurrent: 2,
    })
    // Insert features with explicit feature_index values whose physical INSERT
    // (rowid) order differs from feature_index order. A regression that drops
    // ORDER BY feature_index ASC would return rows in rowid order instead.
    const ts = Date.now()
    const insertFeature = db!.prepare(`
      INSERT INTO group_features (
        project_id, group_id, feature_index, title, description, stage,
        architect_session_id, loop_name, error, attempts, created_at, updated_at
      ) VALUES ('p1', 'g-1', ?, ?, ?, 'pending', NULL, NULL, NULL, 0, ?, ?)
    `)
    insertFeature.run(2, 'Feature C', 'c', ts, ts)
    insertFeature.run(0, 'Feature A', 'a', ts, ts)
    insertFeature.run(1, 'Feature B', 'b', ts, ts)

    const payload = collectDashboardData(db!)
    expect(payload.projects[0].groups).toHaveLength(1)
    const g = payload.projects[0].groups[0]
    expect(g.id).toBe('g-1')
    expect(g.group.groupId).toBe('g-1')
    expect(g.group.title).toBe('Group One')
    expect(g.group.maxConcurrent).toBe(2)
    expect(g.features.map(f => f.featureIndex)).toEqual([0, 1, 2])
    expect(g.features.map(f => f.title)).toEqual(['Feature A', 'Feature B', 'Feature C'])
  })

  test('prdText longer than 400 chars is exposed as a 400-char prdPreview and raw prdText is absent', () => {
    const loopsRepo = createLoopsRepo(db!)
    const groupsRepo = createFeatureGroupsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'l1' }),
      { lastAuditResult: null },
    )
    const longPrd = 'P'.repeat(1000)
    groupsRepo.createGroup({
      projectId: 'p1',
      groupId: 'g-1',
      title: 'Group One',
      status: 'running',
      prdText: longPrd,
    })

    const payload = collectDashboardData(db!)
    const g = payload.projects[0].groups[0]
    expect((g.group as Record<string, unknown>).prdText).toBeUndefined()
    expect(g.group.prdPreview).toHaveLength(400)
    expect(g.group.prdPreview).toBe('P'.repeat(400))
  })

  test('a database without the feature_groups table returns groups: [] and does not throw', () => {
    // Build a database with only the loops + minimum tables by dropping
    // feature_groups; relies on hasTable() gating the repo construction.
    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'l1' }),
      { lastAuditResult: null },
    )
    db!.exec('DROP TABLE group_features')
    db!.exec('DROP TABLE feature_groups')

    expect(() => collectDashboardData(db!)).not.toThrow()
    const payload = collectDashboardData(db!)
    expect(payload.projects[0].groups).toEqual([])
  })

  test('a project containing only a feature group appears with loops: [] and populated groups', () => {
    const groupsRepo = createFeatureGroupsRepo(db!)
    groupsRepo.createGroup({
      projectId: 'p1',
      groupId: 'g-1',
      title: 'Group One',
      status: 'extracting',
      maxConcurrent: 2,
    })
    groupsRepo.insertFeatures('p1', 'g-1', [
      { title: 'Feature A', description: 'a' },
    ])

    const payload = collectDashboardData(db!)
    expect(payload.projects).toHaveLength(1)
    const proj = payload.projects[0]
    expect(proj.projectId).toBe('p1')
    expect(proj.loops).toEqual([])
    expect(proj.groups).toHaveLength(1)
    expect(proj.groups[0].group.groupId).toBe('g-1')
    expect(proj.groups[0].features).toHaveLength(1)
  })

  test('groups from another project_id do not leak into this project', () => {
    const loopsRepo = createLoopsRepo(db!)
    const groupsRepo = createFeatureGroupsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'l1' }),
      { lastAuditResult: null },
    )
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p2', loopName: 'l2' }),
      { lastAuditResult: null },
    )
    groupsRepo.createGroup({
      projectId: 'p2',
      groupId: 'g-other',
      title: 'Other Project Group',
      status: 'running',
    })

    const payload = collectDashboardData(db!)
    const p1 = payload.projects.find(p => p.projectId === 'p1')!
    const p2 = payload.projects.find(p => p.projectId === 'p2')!
    expect(p1.groups).toEqual([])
    expect(p2.groups).toHaveLength(1)
    expect(p2.groups[0].group.groupId).toBe('g-other')
  })

  // ─── Cycle 9: query-scoped payload (Phase 1) ──────────────────────────

  test('unscoped payload reports hasPlan but omits plan content', () => {
    const loopsRepo = createLoopsRepo(db!)
    const plansRepo = createPlansRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-a' }),
      { lastAuditResult: null },
    )
    plansRepo.writeForLoop('p1', 'loop-a', 'plan-content-1')

    const payload = collectDashboardData(db!)
    const dl = payload.projects[0].loops[0]
    expect(dl.plan).toBeNull()
    expect(dl.hasPlan).toBe(true)
  })

  test('scoping to a loop returns that loop\'s plan content', () => {
    const loopsRepo = createLoopsRepo(db!)
    const plansRepo = createPlansRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-a' }),
      { lastAuditResult: null },
    )
    plansRepo.writeForLoop('p1', 'loop-a', 'plan-content-1')

    const payload = collectDashboardData(db!, { projectId: 'p1', loopName: 'loop-a' })
    const dl = payload.projects[0].loops[0]
    expect(dl.plan).toBe('plan-content-1')
    expect(dl.hasPlan).toBe(true)
  })

  test('a sibling loop in the scoped project reports hasPlan without content', () => {
    const loopsRepo = createLoopsRepo(db!)
    const plansRepo = createPlansRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-a' }),
      { lastAuditResult: null },
    )
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-b', currentSessionId: 'session-b' }),
      { lastAuditResult: null },
    )
    plansRepo.writeForLoop('p1', 'loop-a', 'plan-content-a')
    plansRepo.writeForLoop('p1', 'loop-b', 'plan-content-b')

    const scope: DashboardScope = { projectId: 'p1', loopName: 'loop-a' }
    const payload = collectDashboardData(db!, scope)
    const loops = payload.projects[0].loops
    const a = loops.find(l => l.loop.loopName === 'loop-a')!
    const b = loops.find(l => l.loop.loopName === 'loop-b')!
    expect(a.plan).toBe('plan-content-a')
    expect(a.hasPlan).toBe(true)
    expect(b.plan).toBeNull()
    expect(b.hasPlan).toBe(true)
  })

  test('sectionCount is populated while sections is empty when unscoped', () => {
    const loopsRepo = createLoopsRepo(db!)
    const sectionsRepo = createSectionPlansRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-a' }),
      { lastAuditResult: null },
    )
    sectionsRepo.bulkInsert({
      projectId: 'p1',
      loopName: 'loop-a',
      sections: [
        { index: 0, title: 'Section A', content: 'Content A' },
        { index: 1, title: 'Section B', content: 'Content B' },
      ],
    })

    const unscoped = collectDashboardData(db!)
    const unscopedDl = unscoped.projects[0].loops[0]
    expect(unscopedDl.sections).toHaveLength(0)
    expect(unscopedDl.sectionCount).toBe(2)

    const scoped = collectDashboardData(db!, { projectId: 'p1', loopName: 'loop-a' })
    const scopedDl = scoped.projects[0].loops[0]
    expect(scopedDl.sections).toHaveLength(2)
    expect(scopedDl.sectionCount).toBe(2)
    expect(scopedDl.sections.map(s => s.title)).toEqual(['Section A', 'Section B'])
  })

  test('goal, lastAuditResult and postActionReport are null unless the loop is scoped', () => {
    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-a', kind: 'goal' }),
      { lastAuditResult: 'audit-x', postActionReport: 'report-x', goal: 'goal-x' },
    )

    const unscoped = collectDashboardData(db!)
    const unscopedDl = unscoped.projects[0].loops[0]
    expect(unscopedDl.goal).toBeNull()
    expect(unscopedDl.lastAuditResult).toBeNull()
    expect(unscopedDl.postActionReport).toBeNull()

    const scoped = collectDashboardData(db!, { projectId: 'p1', loopName: 'loop-a' })
    const scopedDl = scoped.projects[0].loops[0]
    expect(scopedDl.goal).toBe('goal-x')
    expect(scopedDl.lastAuditResult).toBe('audit-x')
    expect(scopedDl.postActionReport).toBe('report-x')
  })

  test('completionSummary is null unless the loop is scoped', () => {
    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({
        projectId: 'p1',
        loopName: 'loop-a',
        status: 'completed',
        completedAt: 1700000500000,
        completionSummary: 'COMPLETION BODY',
      }),
      { lastAuditResult: null },
    )
    loopsRepo.insert(
      makeLoopRow({
        projectId: 'p1',
        loopName: 'loop-b',
        currentSessionId: 'session-b',
        status: 'completed',
        completedAt: 1700000500000,
        completionSummary: 'SIBLING BODY',
      }),
      { lastAuditResult: null },
    )

    const unscoped = collectDashboardData(db!)
    expect(unscoped.projects[0].loops[0].loop.completionSummary).toBeNull()
    expect(unscoped.projects[0].loops[1].loop.completionSummary).toBeNull()

    const scopedSibling = collectDashboardData(db!, { projectId: 'p1', loopName: 'loop-b' })
    const scopedSiblingLoops = scopedSibling.projects[0].loops
    const siblingB = scopedSiblingLoops.find(dl => dl.id === 'loop-b')!
    const siblingA = scopedSiblingLoops.find(dl => dl.id === 'loop-a')!
    expect(siblingB.loop.completionSummary).toBe('SIBLING BODY')
    expect(siblingA.loop.completionSummary).toBeNull()

    const scoped = collectDashboardData(db!, { projectId: 'p1', loopName: 'loop-a' })
    const scopedA = scoped.projects[0].loops.find(dl => dl.id === 'loop-a')!
    expect(scopedA.loop.completionSummary).toBe('COMPLETION BODY')
  })

  test('amendments ship only for the scoped loop', () => {
    const loopsRepo = createLoopsRepo(db!)
    const amendmentsRepo = createPlanAmendmentsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-a' }),
      { lastAuditResult: null },
    )
    amendmentsRepo.insert({
      projectId: 'p1',
      loopName: 'loop-a',
      source: 'auditor',
      rationale: 'trim sections',
      appliedAtSection: 1,
      sectionsBefore: JSON.stringify([{ index: 1, title: 'Old', content: 'c-old' }]),
      sectionsAfter: JSON.stringify([{ index: 1, title: 'New', content: 'c-new' }]),
    })

    const unscoped = collectDashboardData(db!)
    expect(unscoped.projects[0].loops[0].amendments).toEqual([])

    const scoped = collectDashboardData(db!, { projectId: 'p1', loopName: 'loop-a' })
    const scopedDl = scoped.projects[0].loops[0]
    expect(scopedDl.amendments).toHaveLength(1)
    expect(scopedDl.amendments[0].rationale).toBe('trim sections')
    expect(scopedDl.amendments[0].sectionsBefore).toBe(JSON.stringify([{ index: 1, title: 'Old' }]))
    expect(scopedDl.amendments[0].sectionsAfter).toBe(JSON.stringify([{ index: 1, title: 'New' }]))
  })

  test('transitions ship for every loop in the scoped project and none outside it', () => {
    const loopsRepo = createLoopsRepo(db!)
    const transitionsRepo = createLoopTransitionsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-a' }),
      { lastAuditResult: null },
    )
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-c', currentSessionId: 'session-c' }),
      { lastAuditResult: null },
    )
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p2', loopName: 'loop-b', currentSessionId: 'session-b' }),
      { lastAuditResult: null },
    )
    for (const [pid, ln] of [['p1', 'loop-a'], ['p1', 'loop-c'], ['p2', 'loop-b']] as const) {
      transitionsRepo.insert({
        projectId: pid,
        loopName: ln,
        eventType: 'phase-change',
        transitionKind: 'next',
        fromPhase: 'coding',
        toPhase: 'audit',
        status: null,
        reason: 'done',
        iteration: 1,
        sectionIndex: null,
      })
    }

    const unscoped = collectDashboardData(db!)
    expect(unscoped.projects.find(p => p.projectId === 'p1')!.loops.find(l => l.id === 'loop-a')!.transitions).toEqual([])
    expect(unscoped.projects.find(p => p.projectId === 'p1')!.loops.find(l => l.id === 'loop-c')!.transitions).toEqual([])
    expect(unscoped.projects.find(p => p.projectId === 'p2')!.loops[0].transitions).toEqual([])

    const scoped = collectDashboardData(db!, { projectId: 'p1', loopName: 'loop-a' })
    const p1 = scoped.projects.find(p => p.projectId === 'p1')!
    expect(p1.loops.find(l => l.id === 'loop-a')!.transitions).toHaveLength(1)
    expect(p1.loops.find(l => l.id === 'loop-c')!.transitions).toHaveLength(1)
    expect(scoped.projects.find(p => p.projectId === 'p2')!.loops[0].transitions).toEqual([])
  })

  test('findings and usage are populated regardless of scope', () => {
    const loopsRepo = createLoopsRepo(db!)
    const findingsRepo = createReviewFindingsRepo(db!)
    const usageRepo = createLoopSessionUsageRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-a' }),
      { lastAuditResult: null },
    )
    findingsRepo.write({
      projectId: 'p1',
      loopName: 'loop-a',
      file: 'src/main.ts',
      line: 10,
      severity: 'warning',
      description: 'w',
    })
    usageRepo.upsertSessionUsage({
      projectId: 'p1',
      loopName: 'loop-a',
      sessionId: 'session-1',
      role: 'code',
      model: 'claude-sonnet-4-20250514',
      cost: 0.01,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      messageCount: 3,
      capturedAt: Date.now(),
    })

    const unscoped = collectDashboardData(db!)
    const unscopedDl = unscoped.projects[0].loops[0]
    expect(unscopedDl.findings).toHaveLength(1)
    expect(unscopedDl.usage).not.toBeNull()
    expect(unscopedDl.usage!.totalCost).toBe(0.01)

    const scoped = collectDashboardData(db!, { projectId: 'p1', loopName: 'loop-a' })
    const scopedDl = scoped.projects[0].loops[0]
    expect(scopedDl.findings).toHaveLength(1)
    expect(scopedDl.usage).not.toBeNull()
    expect(scopedDl.usage!.totalCost).toBe(0.01)
  })

  test('a scope naming a project that does not exist behaves like no scope', () => {
    const loopsRepo = createLoopsRepo(db!)
    const plansRepo = createPlansRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-a' }),
      { lastAuditResult: 'audit-x', postActionReport: 'report-x', goal: 'goal-x' },
    )
    plansRepo.writeForLoop('p1', 'loop-a', 'plan-content-a')

    const scope: DashboardScope = { projectId: 'nope', loopName: 'nope' }
    const payload = collectDashboardData(db!, scope)
    expect(payload.projects).toHaveLength(1)
    const dl = payload.projects[0].loops[0]
    expect(dl.plan).toBeNull()
    expect(dl.hasPlan).toBe(true)
    expect(dl.goal).toBeNull()
    expect(dl.lastAuditResult).toBeNull()
    expect(dl.postActionReport).toBeNull()
    expect(dl.sections).toEqual([])
    expect(dl.transitions).toEqual([])
    expect(dl.amendments).toEqual([])
  })
})
