import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { openForgeDatabase, closeDatabase } from '../../src/storage/database'
import { createRequestHandler, type DashboardDeps } from '../../src/dashboard/server'
import { createLoopRunsRepo, createLoopsRepo, type LoopRow, type LoopRunRow } from '../../src/storage'

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

function makeRun(overrides: Partial<LoopRunRow> = {}): LoopRunRow {
  return {
    projectId: 'p1', loopName: 'run-a', startedAt: 1000, completedAt: 2000,
    status: 'completed', terminationReason: null, loopKind: 'plan', executionModel: null,
    auditorModel: null, executionVariant: null, auditorVariant: null, iterations: 1,
    auditCount: 1, errorCount: 0, totalSections: 0, sectionRetries: 0, cleanAudits: 1,
    dirtyAudits: 0, cost: 0.1, inputTokens: 10, outputTokens: 5, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, messageCount: 2, durationMs: 1000,
    createdAt: 2000, ...overrides,
  }
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

  // ─── Cycle 2: /api/data returns JSON with projects and totals ────────

  test('GET /api/data returns 200 with application/json and no-store cache', async () => {
    const handler = createRequestHandler(makeDeps(db!))
    const res = handler(new Request('http://localhost/api/data'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = await res.json()
    expect(body).toHaveProperty('projects')
    expect(body).toHaveProperty('totals')
    expect(Array.isArray(body.projects)).toBe(true)
    expect(body.totals.projects).toBe(0)
    expect(body.totals.loops).toBe(0)
  })

  // ─── Cycle 3: live re-query — inserting a loop changes /api/data ─────

  test('GET /api/data reflects DB changes after handler creation (live query)', async () => {
    const handler = createRequestHandler(makeDeps(db!))

    // Verify empty before insertion
    const resBefore = await handler(new Request('http://localhost/api/data'))
    const bodyBefore = await resBefore.json()
    expect(bodyBefore.totals.loops).toBe(0)

    // Insert a loop via the same db reference
    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.insert(
      makeLoopRow({ projectId: 'p1', loopName: 'newly-inserted' }),
      { lastAuditResult: null },
    )

    // Verify data now includes the new loop
    const resAfter = await handler(new Request('http://localhost/api/data'))
    const bodyAfter = await resAfter.json()
    expect(bodyAfter.totals.loops).toBe(1)
    expect(bodyAfter.projects).toHaveLength(1)
    expect(bodyAfter.projects[0].projectId).toBe('p1')
    expect(bodyAfter.projects[0].loops[0].loop.loopName).toBe('newly-inserted')
  })

  test('GET /api/loop-detail validates parameters and returns full detail or 404', async () => {
    const handler = createRequestHandler(makeDeps(db!))
    expect(handler(new Request('http://localhost/api/loop-detail')).status).toBe(400)
    createLoopsRepo(db!).insert(makeLoopRow({ projectId: 'p1', loopName: 'loop one' }), { lastAuditResult: 'clean' })

    const found = handler(new Request('http://localhost/api/loop-detail?projectId=p1&loopName=loop%20one'))
    expect(found.status).toBe(200)
    expect(found.headers.get('cache-control')).toBe('no-store')
    expect(await found.json()).toMatchObject({ lastAuditResult: 'clean', loop: { loopName: 'loop one' } })
    expect(handler(new Request('http://localhost/api/loop-detail?projectId=p1&loopName=missing')).status).toBe(404)
  })

  test('GET /api/runs validates, clamps, filters, and paginates', async () => {
    const runsRepo = createLoopRunsRepo(db!)
    runsRepo.upsert(makeRun({ projectId: 'p1', loopName: 'new', startedAt: 300 }))
    runsRepo.upsert(makeRun({ projectId: 'p1', loopName: 'old', startedAt: 100 }))
    runsRepo.upsert(makeRun({ projectId: 'p2', loopName: 'other', startedAt: 400 }))
    const handler = createRequestHandler(makeDeps(db!))

    const response = handler(new Request('http://localhost/api/runs?projectId=p1&offset=1&limit=999'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ total: 2, offset: 1, limit: 200, runs: [{ loopName: 'old' }] })
    expect(handler(new Request('http://localhost/api/runs?offset=-1')).status).toBe(400)
    expect(handler(new Request('http://localhost/api/runs?limit=0')).status).toBe(400)
    expect(handler(new Request('http://localhost/api/runs?projectId=')).status).toBe(400)
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
})
