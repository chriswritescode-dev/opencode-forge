import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { openForgeDatabase, closeDatabase } from '../../src/storage/database'
import { createRequestHandler } from '../../src/dashboard/server'
import { createLoopsRepo, type LoopRow } from '../../src/storage'

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
    ...overrides,
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
    const handler = createRequestHandler(db!)
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
    const handler = createRequestHandler(db!)
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
    const handler = createRequestHandler(db!)

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

  // ─── Cycle 4: unknown route returns 404 ──────────────────────────────

  test('GET /nope returns 404', () => {
    const handler = createRequestHandler(db!)
    const res = handler(new Request('http://localhost/nope'))
    expect(res.status).toBe(404)
  })

  test('POST / returns 404 (only GET / is served)', () => {
    const handler = createRequestHandler(db!)
    const res = handler(new Request('http://localhost/', { method: 'POST' }))
    expect(res.status).toBe(404)
  })
})
