import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { openForgeDatabase, closeDatabase } from '../../src/storage/database'
import { createRequestHandler, type DashboardDeps } from '../../src/dashboard/server'
import type { OpencodeDataSource } from '../../src/observability/data-source'
import type { OpencodeActivityEvent } from '../../src/observability/types'
import { createEventBroadcaster } from '../../src/dashboard/event-broadcaster'
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

/** Build a deps object with the given forge DB and optional opencode stub. */
function makeDeps(
  forgeDb: Database,
  opencode?: OpencodeDataSource | null,
): DashboardDeps {
  return { forgeDb, opencode: opencode ?? null }
}

/** Create a minimal activity event for testing. */
function makeEvent(overrides?: Partial<OpencodeActivityEvent>): OpencodeActivityEvent {
  return {
    type: 'session_created',
    sessionId: null,
    title: null,
    directory: null,
    time: Date.now(),
    ...overrides,
  }
}

/** A stub opencode datasource for testing. */
function stubDataSource(sessions: any[] = [], transcripts: Record<string, any[]> = {}): OpencodeDataSource {
  return {
    available: true,
    listRecentSessions(limit?: number) {
      return sessions.slice(0, limit ?? sessions.length)
    },
    getSessionTranscript(sessionId: string, limit?: number) {
      const entries = transcripts[sessionId] ?? []
      return entries.slice(0, limit ?? entries.length)
    },
    close() {},
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

  // ─── Cycle 5: /api/opencode/sessions with no datasource ──────────────

  test('GET /api/opencode/sessions returns available=false and empty sessions when no datasource', async () => {
    const handler = createRequestHandler(makeDeps(db!, null))
    const res = handler(new Request('http://localhost/api/opencode/sessions'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)

    const body = await res.json()
    expect(body).toHaveProperty('generatedAt')
    expect(body.available).toBe(false)
    expect(body.sessions).toEqual([])
  })

  test('GET /api/opencode/sessions returns 200 with no-store cache', () => {
    const handler = createRequestHandler(makeDeps(db!, null))
    const res = handler(new Request('http://localhost/api/opencode/sessions'))
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  // ─── Cycle 6: /api/opencode/sessions with stub datasource ────────────

  test('GET /api/opencode/sessions returns stub sessions', async () => {
    const stub = stubDataSource([
      { id: 's1', title: 'Session 1', projectName: 'P1' },
      { id: 's2', title: 'Session 2', projectName: 'P2' },
    ])
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions'))
    const body = await res.json()
    expect(body.available).toBe(true)
    expect(body.sessions).toHaveLength(2)
    expect(body.sessions[0].id).toBe('s1')
    expect(body.sessions[1].id).toBe('s2')
  })

  test('GET /api/opencode/sessions?limit=1 clamps to 1', async () => {
    const stub = stubDataSource([
      { id: 's1', title: 'Session 1' },
      { id: 's2', title: 'Session 2' },
    ])
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions?limit=1'))
    const body = await res.json()
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0].id).toBe('s1')
  })

  // ─── Cycle 7: /api/opencode/sessions/:id with no datasource ──────────

  test('GET /api/opencode/sessions/some-id returns available=false and empty entries when no datasource', async () => {
    const handler = createRequestHandler(makeDeps(db!, null))
    const res = handler(new Request('http://localhost/api/opencode/sessions/some-id'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.available).toBe(false)
    expect(body.sessionId).toBe('some-id')
    expect(body.entries).toEqual([])
  })

  // ─── Cycle 8: /api/opencode/sessions/:id with stub datasource ────────

  test('GET /api/opencode/sessions/:id returns stub transcript', async () => {
    const stub = stubDataSource([], {
      'session-abc': [
        { messageId: 'm1', type: 'text', text: 'hello' },
      ],
    })
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions/session-abc'))
    const body = await res.json()
    expect(body.available).toBe(true)
    expect(body.sessionId).toBe('session-abc')
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].text).toBe('hello')
  })

  test('GET /api/opencode/sessions/:id returns empty entries for unknown session', async () => {
    const stub = stubDataSource([], {
      'session-abc': [{ messageId: 'm1', type: 'text', text: 'hello' }],
    })
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions/unknown'))
    const body = await res.json()
    expect(body.entries).toEqual([])
  })

  test('GET /api/opencode/sessions/:id respects limit param', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      messageId: `m${i}`,
      type: 'text' as const,
      text: `entry-${i}`,
    }))
    const stub = stubDataSource([], { 'ses-full': entries })
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions/ses-full?limit=3'))
    const body = await res.json()
    expect(body.entries).toHaveLength(3)
  })

  // ─── Cycle 9: invalid/default limit values ────────────────────────────

  test('GET /api/opencode/sessions uses default limit (50) when no param', async () => {
    const sessions = Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
    }))
    const stub = stubDataSource(sessions)
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions'))
    const body = await res.json()
    // Default is 50, stub slices so we get 50
    expect(body.sessions).toHaveLength(50)
  })

  test('GET /api/opencode/sessions uses default limit for NaN query value', async () => {
    const sessions = Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
    }))
    const stub = stubDataSource(sessions)
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions?limit=abc'))
    const body = await res.json()
    expect(body.sessions).toHaveLength(50)
  })

  test('GET /api/opencode/sessions clamps limit=0 to 1', async () => {
    const stub = stubDataSource([
      { id: 's1', title: 'Session 1' },
      { id: 's2', title: 'Session 2' },
    ])
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions?limit=0'))
    const body = await res.json()
    expect(body.sessions).toHaveLength(1)
  })

  test('GET /api/opencode/sessions/:id uses default limit (500) when no param', async () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      messageId: `m${i}`,
      type: 'text' as const,
      text: `entry-${i}`,
    }))
    const stub = stubDataSource([], { 'ses-big': entries })
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions/ses-big'))
    const body = await res.json()
    // Default is 500, stub slices so we get 500
    expect(body.entries).toHaveLength(500)
  })

  test('GET /api/opencode/sessions/:id uses default limit for NaN query value', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      messageId: `m${i}`,
      type: 'text' as const,
      text: `entry-${i}`,
    }))
    const stub = stubDataSource([], { 'ses-abc': entries })
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions/ses-abc?limit=NaN'))
    const body = await res.json()
    // NaN → !isFinite → defaultValue (500), stub has 100 entries → all returned
    expect(body.entries).toHaveLength(100)
  })

  test('GET /api/opencode/sessions/:id clamps limit=0 to 1', async () => {
    const stub = stubDataSource([], {
      'ses-min': [
        { messageId: 'm1', type: 'text', text: 'only one' },
        { messageId: 'm2', type: 'text', text: 'two' },
      ],
    })
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions/ses-min?limit=0'))
    const body = await res.json()
    expect(body.entries).toHaveLength(1)
  })

  test('GET /api/opencode/sessions/:id works with empty limit string (falls through to default)', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      messageId: `m${i}`,
      type: 'text' as const,
      text: `entry-${i}`,
    }))
    const stub = stubDataSource([], { 'ses-empty': entries })
    const handler = createRequestHandler(makeDeps(db!, stub))

    // limit=  (empty string) → Number("") = 0 → clamped to min 1
    const res = handler(new Request('http://localhost/api/opencode/sessions/ses-empty?limit='))
    const body = await res.json()
    expect(body.entries).toHaveLength(1)
  })

  test('GET /api/opencode/sessions/:id works with Infinity query value', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      messageId: `m${i}`,
      type: 'text' as const,
      text: `entry-${i}`,
    }))
    const stub = stubDataSource([], { 'ses-inf': entries })
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions/ses-inf?limit=Infinity'))
    const body = await res.json()
    // Infinity → !isFinite → defaultValue (500), stub has 5
    expect(body.entries).toHaveLength(5)
  })

  test('GET /api/opencode/sessions/:id works with encoded session IDs', async () => {
    const stub = stubDataSource([], {
      'session/path': [{ messageId: 'm1', type: 'text', text: 'encoded' }],
    })
    const handler = createRequestHandler(makeDeps(db!, stub))

    const res = handler(new Request('http://localhost/api/opencode/sessions/session%2Fpath'))
    const body = await res.json()
    expect(body.sessionId).toBe('session/path')
    expect(body.entries).toHaveLength(1)
  })

  // ─── Cycle 9: existing behavior unchanged ─────────────────────────────

  test('existing 404 routes still work', () => {
    const handler = createRequestHandler(makeDeps(db!, null))
    const res = handler(new Request('http://localhost/api/opencode'))
    expect(res.status).toBe(404)
  })

  // ─── Cycle 10: SSE /api/opencode/events ───────────────────────────────

  test('GET /api/opencode/events returns 204 when no broadcaster', () => {
    const handler = createRequestHandler(makeDeps(db!, null))
    const res = handler(new Request('http://localhost/api/opencode/events'))
    expect(res.status).toBe(204)
  })

  test('GET /api/opencode/events returns 200 + text/event-stream with broadcaster', async () => {
    const b = createEventBroadcaster({ bufferSize: 10 })
    const deps: DashboardDeps = { ...makeDeps(db!), events: b }
    const handler = createRequestHandler(deps)
    const res = handler(new Request('http://localhost/api/opencode/events'))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-store')

    // Read the first chunk (connection comment) then cancel the stream.
    const reader = res.body!.getReader()
    const { value, done } = await reader.read()
    expect(done).toBe(false)
    const text = new TextDecoder().decode(value)
    expect(text).toContain(': connected')
    await reader.cancel()
  })

  test('GET /api/opencode/events replays recent events', async () => {
    const b = createEventBroadcaster({ bufferSize: 10 })
    b.publish(makeEvent({ type: 'evt-1', time: 1000 }))
    b.publish(makeEvent({ type: 'evt-2', time: 2000 }))

    const deps: DashboardDeps = { ...makeDeps(db!), events: b }
    const handler = createRequestHandler(deps)
    const res = handler(new Request('http://localhost/api/opencode/events'))

    const reader = res.body!.getReader()
    // Chunk 1: connection comment
    const c1 = new TextDecoder().decode((await reader.read()).value)
    expect(c1).toContain(': connected')
    // Chunk 2: first replayed event
    const c2 = new TextDecoder().decode((await reader.read()).value)
    expect(c2).toContain('"evt-1"')
    // Chunk 3: second replayed event
    const c3 = new TextDecoder().decode((await reader.read()).value)
    expect(c3).toContain('"evt-2"')
    await reader.cancel()
  })

  // ─── Cycle 11: per-session transcript filtering (?session=) ───────────

  test('unscoped /events drops message.part.* events but keeps session events', async () => {
    const b = createEventBroadcaster({ bufferSize: 10 })
    b.publish(makeEvent({ type: 'session.updated', sessionId: 'ses_1' }))
    b.publish(makeEvent({ type: 'message.part.updated', sessionId: 'ses_1' }))

    const deps: DashboardDeps = { ...makeDeps(db!), events: b }
    const handler = createRequestHandler(deps)
    const res = handler(new Request('http://localhost/api/opencode/events'))

    const reader = res.body!.getReader()
    const c1 = new TextDecoder().decode((await reader.read()).value)
    expect(c1).toContain(': connected')
    // Only the session-level event replays; the part event is filtered out.
    const c2 = new TextDecoder().decode((await reader.read()).value)
    expect(c2).toContain('session.updated')
    expect(c2).not.toContain('message.part.updated')
    await reader.cancel()
  })

  test('scoped /events?session= replays part events for the matching session only', async () => {
    const b = createEventBroadcaster({ bufferSize: 10 })
    b.publish(makeEvent({ type: 'message.part.updated', sessionId: 'other' }))
    b.publish(makeEvent({ type: 'message.part.updated', sessionId: 'ses_1', title: 'mine' }))

    const deps: DashboardDeps = { ...makeDeps(db!), events: b }
    const handler = createRequestHandler(deps)
    const res = handler(new Request('http://localhost/api/opencode/events?session=ses_1'))

    const reader = res.body!.getReader()
    const c1 = new TextDecoder().decode((await reader.read()).value)
    expect(c1).toContain(': connected')
    // The non-matching session's part event is skipped; only ses_1's replays.
    const c2 = new TextDecoder().decode((await reader.read()).value)
    expect(c2).toContain('"sessionId":"ses_1"')
    expect(c2).not.toContain('"sessionId":"other"')
    await reader.cancel()
  })
})
