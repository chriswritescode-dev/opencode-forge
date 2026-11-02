import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import {
  createLoopsRepo,
  createLoopSessionUsageRepo,
  createLoopTransitionsRepo,
  createPlanAmendmentsRepo,
  createPlansRepo,
  createReviewFindingsRepo,
  createSectionPlansRepo,
  type LoopSessionUsageRow,
} from '../../src/storage'
import { createDashboardService, type DashboardService, type DashboardServiceDeps } from '../../src/services/dashboard-service'
import { withWriteNotifications } from '../../src/utils/write-notifications'
import { FORGE_RPC, type ForgeDashboardSummary } from '../../src/host/forge-rpc'
import { makeLoopRow } from '../helpers/dashboard-fixtures'
import { expectMatchesJsonSchema } from '../helpers/json-schema'
import { createTestDb, type TestDb } from '../helpers/test-db'

function usageRow(overrides: Partial<LoopSessionUsageRow> = {}): LoopSessionUsageRow {
  return {
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
    ...overrides,
  }
}

describe('DashboardService', () => {
  let testDb: TestDb
  let db: Database

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
  })

  afterEach(() => {
    testDb.cleanup()
  })

  function dashboardDeps(overrides: Partial<DashboardServiceDeps> = {}): DashboardServiceDeps {
    return {
      db: db,
      loopsRepo: createLoopsRepo(db),
      plansRepo: createPlansRepo(db),
      sectionPlansRepo: createSectionPlansRepo(db),
      reviewFindingsRepo: createReviewFindingsRepo(db),
      loopSessionUsageRepo: createLoopSessionUsageRepo(db),
      loopTransitionsRepo: createLoopTransitionsRepo(db),
      amendmentsRepo: createPlanAmendmentsRepo(db),
      ...overrides,
    }
  }

  function service(): DashboardService {
    return createDashboardService(dashboardDeps())
  }

  function summary(): ForgeDashboardSummary {
    const result = service().getSummary()
    if ('error' in result) throw new Error(result.error)
    return result
  }

  test('an empty database returns no projects', () => {
    const result = summary()
    expect(result.projects).toEqual([])
    expect(result.generatedAt).toBeGreaterThan(0)
  })

  test('deletePlan deletes once through the wrapped repo and reports a missing plan', () => {
    const plansRepo = createPlansRepo(db)
    plansRepo.writeForSession('p1', 'ses_1', '# Plan')
    const notify = vi.fn()
    const dashboard = createDashboardService(dashboardDeps({
      plansRepo: withWriteNotifications(plansRepo, ['writeForSession', 'deleteForSession', 'promote'], notify),
    }))

    expect(dashboard.deletePlan('p1', 'ses_1')).toEqual({ deleted: true })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(plansRepo.getForSession('p1', 'ses_1')).toBeNull()

    expect(dashboard.deletePlan('p1', 'ses_1')).toEqual({ error: 'Plan not found' })
    expect(notify).toHaveBeenCalledTimes(2)
  })

  test('reports loop counts, plan/section/bug state, costs and duration', () => {
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const sectionsRepo = createSectionPlansRepo(db)
    const findingsRepo = createReviewFindingsRepo(db)
    const usageRepo = createLoopSessionUsageRepo(db)

    loopsRepo.insert(makeLoopRow({
      projectId: 'p1',
      loopName: 'loop-a',
      status: 'completed',
      startedAt: 1000,
      completedAt: 1000 + 125_000,
      currentSectionIndex: 1,
      totalSections: 3,
      worktreeBranch: 'feat/loop-a',
      executionModel: 'claude-sonnet-4-20250514',
      auditorModel: 'claude-opus-4-20250514',
    }), { lastAuditResult: null })
    plansRepo.writeForLoop('p1', 'loop-a', '# Plan')
    sectionsRepo.bulkInsert({
      projectId: 'p1',
      loopName: 'loop-a',
      sections: [
        { index: 0, title: 'Section A', content: 'Content A' },
        { index: 1, title: 'Section B', content: 'Content B' },
      ],
    })
    findingsRepo.write({ projectId: 'p1', loopName: 'loop-a', file: 'src/main.ts', line: 10, severity: 'bug', description: 'b' })
    findingsRepo.write({ projectId: 'p1', loopName: 'loop-a', file: 'src/main.ts', line: 20, severity: 'warning', description: 'w' })
    usageRepo.upsertSessionUsage(usageRow({ cost: 0.02 }))

    const project = summary().projects[0]
    expect(project.projectId).toBe('p1')
    expect(project.projectDir).toBe('/tmp/test')
    expect(project.loopCount).toBe(1)
    expect(project.bugCount).toBe(1)

    const loop = project.loops[0]
    expect(loop).toMatchObject({
      loopName: 'loop-a',
      status: 'completed',
      phase: 'coding',
      currentSectionIndex: 1,
      totalSections: 3,
      sectionCount: 2,
      bugCount: 1,
      hasPlan: true,
      startedAt: 1000,
      completedAt: 126_000,
      activityAt: 126_000,
      durationText: '2m 5s',
      totalCost: 0.02,
      branch: 'feat/loop-a',
      executionModel: 'claude-sonnet-4-20250514',
      auditorModel: 'claude-opus-4-20250514',
    })
  })

  test('sorts running loops first, then by startedAt desc within each group', () => {
    const loopsRepo = createLoopsRepo(db)
    loopsRepo.insert(makeLoopRow({ projectId: 'p1', loopName: 'completed-loop', currentSessionId: 's1', status: 'completed', startedAt: 100, completedAt: 150 }), { lastAuditResult: null })
    loopsRepo.insert(makeLoopRow({ projectId: 'p1', loopName: 'running-loop', currentSessionId: 's2', status: 'running', startedAt: 300 }), { lastAuditResult: null })
    loopsRepo.insert(makeLoopRow({ projectId: 'p1', loopName: 'cancelled-loop', currentSessionId: 's3', status: 'cancelled', startedAt: 200, completedAt: 250 }), { lastAuditResult: null })

    expect(summary().projects[0].loops.map((loop) => loop.loopName))
      .toEqual(['running-loop', 'cancelled-loop', 'completed-loop'])
  })

  test('discovers the union of loop and unexecuted-plan projects, sorted by id', () => {
    createLoopsRepo(db).insert(makeLoopRow({ projectId: 'p1', loopName: 'loop-a' }), { lastAuditResult: null })
    createPlansRepo(db).writeForSession('p2', 'session-plan', '# Objective\n\nA plan')

    const projects = summary().projects
    expect(projects.map((project) => project.projectId)).toEqual(['p1', 'p2'])
    expect(projects[0].loopCount).toBe(1)
    expect(projects[1].loops).toEqual([])
    expect(projects[1].unexecutedPlanCount).toBe(1)
    expect(projects[1].unexecutedPlans.map((plan) => plan.sessionId)).toEqual(['session-plan'])
  })

  test('ships unexecuted plans for every project, not only the first', () => {
    const plansRepo = createPlansRepo(db)
    for (const projectId of ['p1', 'p2']) {
      plansRepo.writeForSession(projectId, `plan-${projectId}`, '# Objective\n\nplan')
    }

    const projects = summary().projects
    expect(projects.map((project) => project.unexecutedPlans.map((plan) => plan.sessionId)))
      .toEqual([['plan-p1'], ['plan-p2']])
  })

  test('an unexecuted session plan ships its derived title and character count', () => {
    const content = '# Objective\n\nReview the unexecuted plan.\n\nLoop Name: review-the-plan'
    createPlansRepo(db).writeForSession('p1', 'session-plan', content)

    const plan = summary().projects[0].unexecutedPlans[0]

    expect(plan).toMatchObject({
      sessionId: 'session-plan',
      title: 'review-the-plan',
      charCount: content.length,
    })
    expect(typeof plan.updatedAt).toBe('number')
    expect(plan).not.toHaveProperty('content')
  })

  test('strips a leading heading marker from an unexecuted plan title and keeps a section-derived title', () => {
    createPlansRepo(db).writeForSession('p1', 'delete-me', '# Plan: Delete me plan\n\nThis plan exists to test deletion.\n')
    createPlansRepo(db).writeForSession('p2', 'objective-plan', '## Objective\n\nKeep this title\n')

    const projects = summary().projects

    expect(projects[0].unexecutedPlans[0].title).toBe('Plan: Delete me plan')
    expect(projects[1].unexecutedPlans[0].title).toBe('Keep this title')
  })

  test('the summary matches the dashboardSummary output schema and contains no nulls', () => {
    createLoopsRepo(db).insert(makeLoopRow({ projectId: 'p1', loopName: 'loop-a', worktreeBranch: 'feat/a' }), { lastAuditResult: null })
    createPlansRepo(db).writeForSession('p2', 'session-plan', '# Objective\n\nA plan')

    const result = summary()
    expectMatchesJsonSchema(FORGE_RPC.methods.dashboardSummary.output, result)
    expect(JSON.stringify(result)).not.toContain('null')
  })

  test('expectMatchesJsonSchema rejects a mismatching value with its failing path', () => {
    const schema = {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['projectId', 'count'],
      additionalProperties: false,
    } as const

    expect(() => expectMatchesJsonSchema(schema, { projectId: 1, count: 1 })).toThrow(/\$\.projectId/)
    expect(() => expectMatchesJsonSchema(schema, { projectId: 'p', count: 1.5 })).toThrow(/\$\.count/)
    expect(() => expectMatchesJsonSchema(schema, { projectId: 'p', count: 1, extra: true })).toThrow(/\$\.extra/)
    expect(() => expectMatchesJsonSchema(schema, { projectId: 'p' })).toThrow(/\$\.count/)
    expect(() => expectMatchesJsonSchema(schema, { projectId: 'p', count: 1 })).not.toThrow()
  })

  describe('getLoopDetail', () => {
    function detail(projectId = 'p1', loopName = 'loop-a') {
      const result = service().getLoopDetail(projectId, loopName)
      if ('error' in result) throw new Error(result.error)
      return result
    }

    test('returns the scoped loop with plan, sections, findings, usage, transitions, amendments and large fields', () => {
      const loopsRepo = createLoopsRepo(db)
      const plansRepo = createPlansRepo(db)
      const sectionsRepo = createSectionPlansRepo(db)
      const findingsRepo = createReviewFindingsRepo(db)
      const usageRepo = createLoopSessionUsageRepo(db)
      const transitionsRepo = createLoopTransitionsRepo(db)
      const amendmentsRepo = createPlanAmendmentsRepo(db)

      loopsRepo.insert(makeLoopRow({
        projectId: 'p1',
        loopName: 'loop-a',
        status: 'completed',
        startedAt: 1000,
        completedAt: 126_000,
        worktreeBranch: 'feat/loop-a',
        executionVariant: 'high',
        auditorModel: 'claude-opus-4-20250514',
        auditorVariant: 'low',
        completionSummary: 'all done',
        baseCommit: 'abc123',
        currentSectionIndex: 1,
        totalSections: 2,
      }), { lastAuditResult: 'audit-result-1', postActionReport: 'report-1' })
      plansRepo.writeForLoop('p1', 'loop-a', '# Plan')
      sectionsRepo.bulkInsert({
        projectId: 'p1',
        loopName: 'loop-a',
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })
      sectionsRepo.setStatus('p1', 'loop-a', 0, 'completed')
      findingsRepo.write({
        projectId: 'p1', loopName: 'loop-a', file: 'src/main.ts', line: 42,
        severity: 'bug', description: 'broken', scenario: 'when run', sectionIndex: 1,
      })
      findingsRepo.write({
        projectId: 'p1', loopName: 'loop-a', file: 'src/other.ts', line: 7,
        severity: 'warning', description: 'smells',
      })
      usageRepo.upsertSessionUsage(usageRow({ projectId: 'p1', loopName: 'loop-a', cost: 0.02 }))
      transitionsRepo.insert({
        projectId: 'p1', loopName: 'loop-a', eventType: 'phase-change', transitionKind: 'next',
        fromPhase: 'coding', toPhase: 'audit', status: null, reason: 'done', iteration: 1, sectionIndex: null,
      })
      amendmentsRepo.insert({
        projectId: 'p1',
        loopName: 'loop-a',
        source: 'auditor',
        rationale: 'remove two redundant sections',
        appliedAtSection: 4,
        sectionsBefore: JSON.stringify([
          { index: 4, title: 'Old Section A', content: 'a' },
          { index: 5, title: 'Old Section B', content: 'b' },
        ]),
        sectionsAfter: JSON.stringify([
          { index: 4, title: 'New Section A', content: 'a-new' },
        ]),
      })

      const result = detail()

      expect(result.loop).toMatchObject({
        projectId: 'p1',
        loopName: 'loop-a',
        status: 'completed',
        phase: 'coding',
        worktreeBranch: 'feat/loop-a',
        executionVariant: 'high',
        auditorModel: 'claude-opus-4-20250514',
        auditorVariant: 'low',
        auditorFallbackIndex: 0,
        baseCommit: 'abc123',
        currentSectionIndex: 1,
        totalSections: 2,
      })
      expect(result.durationText).toBe('2m 5s')
      expect(result.lastAuditResult).toBe('audit-result-1')
      expect(result.postActionReport).toBe('report-1')
      expect(result.completionSummary).toBe('all done')
      expect(result.plan).toBe('# Plan')
      expect(result.sections).toHaveLength(2)
      expect(result.sections[0]).toMatchObject({ sectionIndex: 0, title: 'Section A', status: 'completed' })
      expect(result.findings).toHaveLength(2)
      expect(result.findings[0]).toMatchObject({
        file: 'src/main.ts', line: 42, severity: 'bug', description: 'broken',
        scenario: 'when run', sectionIndex: 1,
      })
      expect(result.findings[1]).not.toHaveProperty('scenario')
      expect(result.usage?.totalCost).toBe(0.02)
      expect(result.usage?.byModel['claude-sonnet-4-20250514'].messageCount).toBe(3)
      expect(result.transitions).toHaveLength(1)
      expect(result.transitions[0]).toMatchObject({
        eventType: 'phase-change', transitionKind: 'next', fromPhase: 'coding', toPhase: 'audit', reason: 'done',
      })
      expect(result.transitions[0]).not.toHaveProperty('status')
      expect(result.transitionsCapped).toBe(false)
      expect(result.amendments).toHaveLength(1)
      expect(result.amendments[0]).toMatchObject({
        rationale: 'remove two redundant sections',
        appliedAtSection: 4,
        summary: { added: 0, removed: 1, modified: 1 },
      })
      expect(result.amendments[0]).not.toHaveProperty('sectionsBefore')
      expect(result.amendments[0]).not.toHaveProperty('sectionsAfter')

      expectMatchesJsonSchema(FORGE_RPC.methods.loopDetail.output, result)
      expect(JSON.stringify(result)).not.toContain('null')
    })

    test('returns Loop not found for an unknown loop', () => {
      expect(service().getLoopDetail('p1', 'missing-loop')).toEqual({ error: 'Loop not found' })
    })

    test('caps transitions at the newest 100 and flags the window', () => {
      const loopsRepo = createLoopsRepo(db)
      const transitionsRepo = createLoopTransitionsRepo(db)
      loopsRepo.insert(makeLoopRow({ projectId: 'p1', loopName: 'capped-loop' }), { lastAuditResult: null })
      for (let i = 0; i < 120; i += 1) {
        transitionsRepo.insert({
          projectId: 'p1', loopName: 'capped-loop', eventType: 'phase-change', transitionKind: 'next',
          fromPhase: 'coding', toPhase: 'audit', status: null, reason: `iter-${i}`, iteration: i, sectionIndex: null,
        })
      }

      const result = detail('p1', 'capped-loop')

      expect(result.transitions).toHaveLength(100)
      expect(result.transitions[0].reason).toBe('iter-20')
      expect(result.transitions[99].reason).toBe('iter-119')
      expect(result.transitionsCapped).toBe(true)
    })

    test('omits every null source field from the detail and the loop row', () => {
      const loopsRepo = createLoopsRepo(db)
      loopsRepo.insert(makeLoopRow({
        projectId: 'p1',
        loopName: 'sparse-loop',
        status: 'completed',
        startedAt: 1000,
        completedAt: 2000,
      }), { lastAuditResult: null })

      const result = detail('p1', 'sparse-loop')

      expect(result).not.toHaveProperty('lastAuditResult')
      expect(result).not.toHaveProperty('postActionReport')
      expect(result).not.toHaveProperty('completionSummary')
      expect(result).not.toHaveProperty('plan')
      expect(result).not.toHaveProperty('usage')
      for (const key of ['worktreeBranch', 'executionVariant', 'auditorModel', 'auditorVariant', 'terminationReason', 'baseCommit']) {
        expect(result.loop).not.toHaveProperty(key)
      }
      expect(JSON.stringify(result)).not.toContain('null')
    })
  })

  describe('getProjectFindings', () => {
    test('groups findings by loop in summary order and omits loops without findings', () => {
      const loopsRepo = createLoopsRepo(db)
      const findingsRepo = createReviewFindingsRepo(db)
      loopsRepo.insert(makeLoopRow({ projectId: 'p1', loopName: 'completed-loop', currentSessionId: 's1', status: 'completed', startedAt: 100, completedAt: 150 }), { lastAuditResult: null })
      loopsRepo.insert(makeLoopRow({ projectId: 'p1', loopName: 'running-old', currentSessionId: 's2', status: 'running', startedAt: 200 }), { lastAuditResult: null })
      loopsRepo.insert(makeLoopRow({ projectId: 'p1', loopName: 'running-new', currentSessionId: 's3', status: 'running', startedAt: 300 }), { lastAuditResult: null })
      loopsRepo.insert(makeLoopRow({ projectId: 'p1', loopName: 'quiet-loop', currentSessionId: 's4', status: 'completed', startedAt: 400, completedAt: 450 }), { lastAuditResult: null })
      findingsRepo.write({ projectId: 'p1', loopName: 'completed-loop', file: 'b.ts', line: 2, severity: 'warning', description: 'w' })
      findingsRepo.write({ projectId: 'p1', loopName: 'running-new', file: 'a.ts', line: 1, severity: 'bug', description: 'b' })

      const result = service().getProjectFindings('p1')
      if ('error' in result) throw new Error(result.error)

      expect(result.loops.map((loop) => loop.loopName)).toEqual(['running-new', 'completed-loop'])
      expect(result.loops[0].findings).toHaveLength(1)
      expect(result.loops[0].findings[0]).toMatchObject({ file: 'a.ts', line: 1, severity: 'bug', description: 'b' })
      expectMatchesJsonSchema(FORGE_RPC.methods.projectFindings.output, result)
      expect(JSON.stringify(result)).not.toContain('null')
    })

    test('orders each loop by file then line and drops findings without a loop', () => {
      const loopsRepo = createLoopsRepo(db)
      const findingsRepo = createReviewFindingsRepo(db)
      loopsRepo.insert(makeLoopRow({ projectId: 'p1', loopName: 'loop-a', currentSessionId: 's1', status: 'running', startedAt: 100 }), { lastAuditResult: null })
      findingsRepo.write({ projectId: 'p1', loopName: 'loop-a', file: 'b.ts', line: 5, severity: 'warning', description: 'b5' })
      findingsRepo.write({ projectId: 'p1', loopName: 'loop-a', file: 'a.ts', line: 9, severity: 'bug', description: 'a9' })
      findingsRepo.write({ projectId: 'p1', loopName: 'loop-a', file: 'a.ts', line: 2, severity: 'bug', description: 'a2' })
      findingsRepo.write({ projectId: 'p1', loopName: null, file: 'c.ts', line: 1, severity: 'bug', description: 'no loop' })

      const result = service().getProjectFindings('p1')
      if ('error' in result) throw new Error(result.error)

      expect(result.loops.map((loop) => loop.loopName)).toEqual(['loop-a'])
      expect(result.loops[0].findings.map((finding) => `${finding.file}:${finding.line}`))
        .toEqual(['a.ts:2', 'a.ts:9', 'b.ts:5'])
    })

    test('an unknown project returns no loops', () => {
      expect(service().getProjectFindings('missing')).toEqual({ loops: [] })
    })
  })

  describe('getAmendmentDiff', () => {
    function seedAmendment(): number {
      createLoopsRepo(db).insert(makeLoopRow({ projectId: 'p1', loopName: 'amended-loop' }), { lastAuditResult: null })
      const amendmentsRepo = createPlanAmendmentsRepo(db)
      amendmentsRepo.insert({
        projectId: 'p1',
        loopName: 'amended-loop',
        source: 'auditor',
        rationale: 'remove two redundant sections',
        appliedAtSection: 4,
        sectionsBefore: JSON.stringify([
          { index: 4, title: 'Old Section A', content: 'a' },
          { index: 5, title: 'Old Section B', content: 'b' },
        ]),
        sectionsAfter: JSON.stringify([
          { index: 4, title: 'New Section A', content: 'a-new' },
        ]),
      })
      return amendmentsRepo.listForLoop('p1', 'amended-loop')[0].id
    }

    test('returns a per-section diff for a real amendment row', () => {
      const rowId = seedAmendment()

      const result = service().getAmendmentDiff('p1', 'amended-loop', rowId)
      if ('error' in result) throw new Error(result.error)

      expect(result.summary).toEqual({ added: 0, removed: 1, modified: 1 })
      const modified = result.sections.find((section) => section.index === 4)
      expect(modified).toMatchObject({ change: 'modified', title: 'New Section A', previousTitle: 'Old Section A' })
      expect(modified?.lines).toContainEqual({ kind: 'remove', text: 'a' })
      expect(modified?.lines).toContainEqual({ kind: 'add', text: 'a-new' })
      const removed = result.sections.find((section) => section.index === 5)
      expect(removed).toMatchObject({ change: 'removed', title: 'Old Section B' })
      expect(removed?.lines).toEqual([{ kind: 'remove', text: 'b' }])
      expectMatchesJsonSchema(FORGE_RPC.methods.amendmentDiff.output, result)
      expect(JSON.stringify(result)).not.toContain('null')
    })

    test('omits previousTitle when a modification keeps the title', () => {
      createLoopsRepo(db).insert(makeLoopRow({ projectId: 'p1', loopName: 'amended-loop' }), { lastAuditResult: null })
      const amendmentsRepo = createPlanAmendmentsRepo(db)
      amendmentsRepo.insert({
        projectId: 'p1',
        loopName: 'amended-loop',
        source: 'auditor',
        rationale: 'reword',
        appliedAtSection: 0,
        sectionsBefore: JSON.stringify([{ index: 0, title: 'Same', content: 'old' }]),
        sectionsAfter: JSON.stringify([{ index: 0, title: 'Same', content: 'new' }]),
      })
      const rowId = amendmentsRepo.listForLoop('p1', 'amended-loop')[0].id

      const result = service().getAmendmentDiff('p1', 'amended-loop', rowId)
      if ('error' in result) throw new Error(result.error)

      expect(result.sections[0].change).toBe('modified')
      expect(result.sections[0]).not.toHaveProperty('previousTitle')
      expect(JSON.stringify(result)).not.toContain('null')
    })

    test('returns Amendment not found for an unknown id', () => {
      const rowId = seedAmendment()

      expect(service().getAmendmentDiff('p1', 'amended-loop', rowId + 1)).toEqual({ error: 'Amendment not found' })
    })
  })
})
