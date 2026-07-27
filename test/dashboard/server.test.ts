import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { openForgeDatabase, closeDatabase } from '../../src/storage/database'
import { createRequestHandler, type DashboardDeps } from '../../src/dashboard/server'
import { createLoopsRepo, createLoopTransitionsRepo, createPlanAmendmentsRepo, createPlansRepo, createFeatureGroupsRepo, type LoopRow, type LoopTransitionRow, type PlanAmendmentRow } from '../../src/storage'

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

/** Build a deps object with the given forge DB. */
function makeDeps(forgeDb: Database): DashboardDeps {
  return { forgeDb }
}

describe('createRequestHandler', () => {
  let db: Database | null = null
  let dbPath: string

  function createDb(): Database {
    const rand = Math.random().toString(36).slice(2, 10)
    dbPath = `/tmp/forge-dashboard-server-test-${rand}.db`
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

  // ─── Cycle 1: root route returns HTML ─────────────────────────────────

  test('GET / returns 200 with text/html content-type and DOCTYPE html', () => {
    const handler = createRequestHandler(makeDeps(db!))
    const res = handler(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    // Must contain DOCTYPE
    return res.text().then(body => {
      expect(body).toMatch(/^<!DOCTYPE html>/)
    })
  })

  // ─── Cycle 2: /api/data returns JSON with projects ───────────────────

  test('GET /api/data returns 200 with application/json and no-store cache', async () => {
    const handler = createRequestHandler(makeDeps(db!))
    const res = handler(new Request('http://localhost/api/data'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = await res.json()
    expect(body).toHaveProperty('projects')
    expect(body).toHaveProperty('generatedAt')
    expect(Array.isArray(body.projects)).toBe(true)
    expect(body.projects).toHaveLength(0)
  })

  // ─── Cycle 3: live re-query — inserting a loop changes /api/data ─────

  test('GET /api/data reflects DB changes after handler creation (live query)', async () => {
    const handler = createRequestHandler(makeDeps(db!))

    // Verify empty before insertion
    const resBefore = await handler(new Request('http://localhost/api/data'))
    const bodyBefore = await resBefore.json()
    expect(bodyBefore.projects).toHaveLength(0)

    // Insert a loop via the same db reference
    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'newly-inserted' }),
      { lastAuditResult: null },
    )

    // Verify data now includes the new loop
    const resAfter = await handler(new Request('http://localhost/api/data'))
    const bodyAfter = await resAfter.json()
    expect(bodyAfter.projects).toHaveLength(1)
    expect(bodyAfter.projects[0].loops).toHaveLength(1)
    expect(bodyAfter.projects[0].projectId).toBe('p1')
    expect(bodyAfter.projects[0].loops[0].loop.loopName).toBe('newly-inserted')
  })

  // ─── Cycle 4: unknown route returns 404 ──────────────────────────────

  test('GET /nope returns 404', () => {
    const handler = createRequestHandler(makeDeps(db!))
    const res = handler(new Request('http://localhost/nope'))
    expect(res.status).toBe(404)
  })

  test('POST / returns 404 (only GET / is served)', () => {
    const handler = createRequestHandler(makeDeps(db!))
    const res = handler(new Request('http://localhost/', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  // ─── Cycle 5: removed opencode routes return 404 ─────────────────────

  test('GET /api/opencode/sessions now returns 404 (feature removed)', () => {
    const handler = createRequestHandler(makeDeps(db!))
    expect(handler(new Request('http://localhost/api/opencode/sessions')).status).toBe(404)
    expect(handler(new Request('http://localhost/api/opencode/events')).status).toBe(404)
    expect(handler(new Request('http://localhost/api/opencode/sessions/abc')).status).toBe(404)
  })

  // ─── Cycle 6: /api/data exposes persisted transitions per loop ─────────

  test('GET /api/data includes per-loop transitions (camelCase, oldest→newest)', async () => {
    const handler = createRequestHandler(makeDeps(db!))

    // Seed a loop and a transition row referencing it.
    const loopsRepo = createLoopsRepo(db!)
    const transitionsRepo = createLoopTransitionsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'transitioned-loop' }),
      { lastAuditResult: null },
    )

    const transitionInput: Omit<LoopTransitionRow, 'id' | 'createdAt'> = {
      projectId: 'p1',
      loopName: 'transitioned-loop',
      eventType: 'phase-change',
      transitionKind: 'next',
      fromPhase: 'coding',
      toPhase: 'audit',
      status: null,
      reason: 'iteration complete',
      iteration: 1,
      sectionIndex: null,
    }
    transitionsRepo.insert(transitionInput)

    const res = await handler(new Request('http://localhost/api/data?project=p1&loop=transitioned-loop'))
    const body = await res.json()
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0].loops).toHaveLength(1)
    const loop = body.projects[0].loops[0]
    expect(Array.isArray(loop.transitions)).toBe(true)
    expect(loop.transitions).toHaveLength(1)
    const row = loop.transitions[0]
    expect(row).toMatchObject({
      projectId: 'p1',
      loopName: 'transitioned-loop',
      eventType: 'phase-change',
      transitionKind: 'next',
      fromPhase: 'coding',
      toPhase: 'audit',
      status: null,
      reason: 'iteration complete',
      iteration: 1,
      sectionIndex: null,
    })
    expect(typeof row.id).toBe('number')
    expect(typeof row.createdAt).toBe('number')
  })

  test('GET /api/data caps transitions at 100 entries in ascending order', async () => {
    const handler = createRequestHandler(makeDeps(db!))

    const loopsRepo = createLoopsRepo(db!)
    const transitionsRepo = createLoopTransitionsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'capped-loop' }),
      { lastAuditResult: null },
    )

    for (let i = 0; i < 120; i++) {
      transitionsRepo.insert({
        projectId: 'p1',
        loopName: 'capped-loop',
        eventType: 'phase-change',
        transitionKind: 'next',
        fromPhase: 'coding',
        toPhase: 'audit',
        status: null,
        reason: `iter-${i}`,
        iteration: i,
        sectionIndex: null,
      })
    }

    const res = await handler(new Request('http://localhost/api/data?project=p1&loop=capped-loop'))
    const body = await res.json()
    const transitions = body.projects[0].loops[0].transitions
    expect(transitions).toHaveLength(100)
    // Newest-100 retained (iterations 20..119) and returned oldest-to-newest,
    // so the oldest overflow row (iter-0) is omitted and the very latest row
    // (iter-119) sits at the end. Long-running loops keep showing recent
    // transitions past the 100-row cap instead of permanently fixing on rows
    // 1-100.
    expect(transitions[0].reason).toBe('iter-20')
    expect(transitions[99].reason).toBe('iter-119')
    expect(transitions.map((t: { reason: string }) => t.reason)).not.toContain('iter-0')
  })

  // ─── Cycle 7: seeded plan_amendments appear as per-loop amendments ─────

  test('GET /api/data includes per-loop amendments (plan_amendments)', async () => {
    const handler = createRequestHandler(makeDeps(db!))

    // Seed a loop and an amendment row.
    const loopsRepo = createLoopsRepo(db!)
    const amendmentsRepo = createPlanAmendmentsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'amended-loop' }),
      { lastAuditResult: null },
    )

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

    const res = await handler(new Request('http://localhost/api/data?project=p1&loop=amended-loop'))
    const body = await res.json()
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0].loops).toHaveLength(1)
    const loopData = body.projects[0].loops[0]
    expect(Array.isArray(loopData.amendments)).toBe(true)
    expect(loopData.amendments).toHaveLength(1)

    const amendment = loopData.amendments[0]
    expect(amendment.projectId).toBe('p1')
    expect(amendment.loopName).toBe('amended-loop')
    expect(amendment.source).toBe('auditor')
    expect(amendment.rationale).toBe('remove two redundant sections')
    expect(amendment.appliedAtSection).toBe(4)
    // Section content is stripped from the poll payload (the UI renders only
    // index+title); the full snapshots stay in plan_amendments.
    expect(amendment.sectionsBefore).toBe(JSON.stringify([
      { index: 4, title: 'Old Section A' },
      { index: 5, title: 'Old Section B' },
    ]))
    expect(amendment.sectionsAfter).toBe(JSON.stringify([
      { index: 4, title: 'New Section A' },
    ]))
    expect(typeof amendment.id).toBe('number')
    expect(typeof amendment.createdAt).toBe('number')
  })

  test('GET /api/data shows no amendments key when table has no rows for that loop', async () => {
    const handler = createRequestHandler(makeDeps(db!))

    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'no-amendments-loop' }),
      { lastAuditResult: null },
    )

    const res = await handler(new Request('http://localhost/api/data?project=p1&loop=no-amendments-loop'))
    const body = await res.json()
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0].loops).toHaveLength(1)
    const loopData = body.projects[0].loops[0]
    expect(Array.isArray(loopData.amendments)).toBe(true)
    expect(loopData.amendments).toHaveLength(0)
  })

  // ─── Cycle 8: feature groups surface under the right project ──────────

  test('GET /api/data against a live database containing a group returns it under the right project', async () => {
    const handler = createRequestHandler(makeDeps(db!))

    const loopsRepo = createLoopsRepo(db!)
    const groupsRepo = createFeatureGroupsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'host-loop' }),
      { lastAuditResult: null },
    )
    groupsRepo.createGroup({
      projectId: 'p1',
      groupId: 'g-1',
      title: 'Group One',
      status: 'running',
      maxConcurrent: 3,
      prdText: 'PRD'.repeat(200),
    })
    groupsRepo.insertFeatures('p1', 'g-1', [
      { title: 'Feature A', description: 'a' },
      { title: 'Feature B', description: 'b' },
    ])

    const res = await handler(new Request('http://localhost/api/data'))
    const body = await res.json()
    expect(body.projects).toHaveLength(1)
    const proj = body.projects[0]
    expect(proj.projectId).toBe('p1')
    expect(Array.isArray(proj.groups)).toBe(true)
    expect(proj.groups).toHaveLength(1)
    const g = proj.groups[0]
    expect(g.id).toBe('g-1')
    expect(g.group.groupId).toBe('g-1')
    expect(g.group.title).toBe('Group One')
    expect(g.group.prdPreview).toHaveLength(400)
    expect(g.group).not.toHaveProperty('prdText')
    expect(g.features).toHaveLength(2)
    expect(g.features.map((f: { featureIndex: number }) => f.featureIndex)).toEqual([0, 1])
  })

  // ─── Cycle 9: scoped /api/data query string ───────────────────────────

  test('GET /api/data?project=p1&loop=loop-a returns plan content only for that loop', async () => {
    const handler = createRequestHandler(makeDeps(db!))

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

    const res = await handler(new Request('http://localhost/api/data?project=p1&loop=loop-a'))
    const body = await res.json()
    expect(body.projects).toHaveLength(1)
    const loops = body.projects[0].loops
    const a = loops.find((l: { loop: { loopName: string } }) => l.loop.loopName === 'loop-a')
    const b = loops.find((l: { loop: { loopName: string } }) => l.loop.loopName === 'loop-b')
    expect(a.plan).toBe('plan-content-a')
    expect(a.hasPlan).toBe(true)
    expect(b.plan).toBeNull()
    expect(b.hasPlan).toBe(true)
  })

  test('GET /api/data scopes completionSummary to the requested loop', async () => {
    const handler = createRequestHandler(makeDeps(db!))

    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({
        projectId: 'p1',
        loopName: 'loop-a',
        status: 'completed',
        completedAt: 1700000500000,
        completionSummary: 'COMPLETION A',
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
        completionSummary: 'COMPLETION B',
      }),
      { lastAuditResult: null },
    )

    const unscoped = await handler(new Request('http://localhost/api/data'))
    const unscopedBody = await unscoped.json()
    const unscopedLoops = unscopedBody.projects[0].loops
    expect(unscopedLoops[0].loop.completionSummary).toBeNull()
    expect(unscopedLoops[1].loop.completionSummary).toBeNull()

    const scoped = await handler(new Request('http://localhost/api/data?project=p1&loop=loop-a'))
    const scopedBody = await scoped.json()
    const scopedLoops = scopedBody.projects[0].loops
    const a = scopedLoops.find((l: { loop: { loopName: string } }) => l.loop.loopName === 'loop-a')
    const b = scopedLoops.find((l: { loop: { loopName: string } }) => l.loop.loopName === 'loop-b')
    expect(a.loop.completionSummary).toBe('COMPLETION A')
    expect(b.loop.completionSummary).toBeNull()
  })
})
