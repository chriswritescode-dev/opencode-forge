import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { openForgeDatabase, closeDatabase } from '../../src/storage/database'
import { createRequestHandler, type DashboardDeps } from '../../src/dashboard/server'
import { createLoopsRepo, createLoopTransitionsRepo, createPlanAmendmentsRepo, createPlansRepo, createFeatureGroupsRepo, type LoopRow, type LoopTransitionRow, type PlanAmendmentRow } from '../../src/storage'
import type { ForgeClient } from '../../src/client/port'

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

  test('GET / returns 200 with text/html content-type and DOCTYPE html', async () => {
    const handler = createRequestHandler(makeDeps(db!))
    const res = await handler(new Request('http://localhost/'))
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
    const res = await handler(new Request('http://localhost/api/data'))
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

  test('GET /nope returns 404', async () => {
    const handler = createRequestHandler(makeDeps(db!))
    const res = await handler(new Request('http://localhost/nope'))
    expect(res.status).toBe(404)
  })

  test('POST / returns 404 (only GET / is served)', async () => {
    const handler = createRequestHandler(makeDeps(db!))
    const res = await handler(new Request('http://localhost/', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  // ─── Cycle 5: removed opencode routes return 404 ─────────────────────

  test('GET /api/opencode/sessions now returns 404 (feature removed)', async () => {
    const handler = createRequestHandler(makeDeps(db!))
    expect((await handler(new Request('http://localhost/api/opencode/sessions'))).status).toBe(404)
    expect((await handler(new Request('http://localhost/api/opencode/events'))).status).toBe(404)
    expect((await handler(new Request('http://localhost/api/opencode/sessions/abc'))).status).toBe(404)
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
    // The multi-KB section snapshots are dropped from the poll payload; the
    // full snapshots stay in plan_amendments and are fetched via the diff endpoint.
    expect(amendment).not.toHaveProperty('sectionsBefore')
    expect(amendment).not.toHaveProperty('sectionsAfter')
    expect(amendment.summary).toEqual({ added: 0, removed: 1, modified: 1 })
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

  describe('GET /api/amendment', () => {
    function seedAmendment(): { amendmentsRepo: ReturnType<typeof createPlanAmendmentsRepo>; rowId: number } {
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
      return { amendmentsRepo, rowId: amendmentsRepo.listForLoop('p1', 'amended-loop')[0].id }
    }

    test('returns a per-section diff for a real amendment row', async () => {
      const handler = createRequestHandler(makeDeps(db!))
      const { rowId } = seedAmendment()

      const res = await handler(new Request(`http://localhost/api/amendment?project=p1&loop=amended-loop&id=${rowId}`))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = await res.json()
      expect(body).toHaveProperty('sections')
      expect(body).toHaveProperty('summary')
      expect(body.sections).toHaveLength(2)
      expect(body.summary).toEqual({ added: 0, removed: 1, modified: 1 })

      const modified = body.sections.find((s: { index: number }) => s.index === 4)
      expect(modified.change).toBe('modified')
      expect(modified.title).toBe('New Section A')
      expect(modified.previousTitle).toBe('Old Section A')
      expect(modified.lines).toContainEqual({ kind: 'remove', text: 'a' })
      expect(modified.lines).toContainEqual({ kind: 'add', text: 'a-new' })

      const removed = body.sections.find((s: { index: number }) => s.index === 5)
      expect(removed.change).toBe('removed')
      expect(removed.title).toBe('Old Section B')
      expect(removed.lines).toEqual([{ kind: 'remove', text: 'b' }])
    })

    test('returns 400 for missing or invalid params', async () => {
      const handler = createRequestHandler(makeDeps(db!))
      const cases = [
        'http://localhost/api/amendment',
        'http://localhost/api/amendment?project=p1',
        'http://localhost/api/amendment?project=p1&loop=amended-loop',
        'http://localhost/api/amendment?project=&loop=amended-loop&id=1',
        'http://localhost/api/amendment?project=p1&loop=&id=1',
        'http://localhost/api/amendment?project=p1&loop=amended-loop&id=abc',
        'http://localhost/api/amendment?project=p1&loop=amended-loop&id=1.5',
        'http://localhost/api/amendment?project=p1&loop=amended-loop&id=-1',
      ]
      for (const url of cases) {
        const res = await handler(new Request(url))
        expect(res.status, url).toBe(400)
      }
    })

    test('returns 404 for an unknown id', async () => {
      const handler = createRequestHandler(makeDeps(db!))
      const res = await handler(new Request('http://localhost/api/amendment?project=p1&loop=amended-loop&id=9999'))
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('Amendment not found.')
    })
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

  // ─── Cycle 10: live session routes ────────────────────────────────────

  interface FakeClientCalls {
    messages: Array<{ sessionID: string; directory?: string }>
    prompts: Array<{ sessionID: string; directory?: string; workspace?: string; parts: unknown }>
    subscribeParams: Array<{ directory?: string; workspace?: string } | undefined>
    subscribed: number
    returned: number
  }

  /**
   * Minimal ForgeClient stand-in: a transcript snapshot plus a hand-fed event
   * stream, so the SSE route can be exercised without an opencode server.
   */
  function makeFakeClient(events: unknown[] = []): { client: ForgeClient; calls: FakeClientCalls } {
    const calls: FakeClientCalls = { messages: [], prompts: [], subscribeParams: [], subscribed: 0, returned: 0 }
    const client = {
      session: {
        messages: async (params: { sessionID: string; directory?: string }) => {
          calls.messages.push(params)
          return [{ info: { id: 'm1', role: 'assistant' }, parts: [] }]
        },
        promptAsync: async (params: { sessionID: string; directory?: string; workspace?: string; parts: unknown }) => {
          calls.prompts.push(params)
        },
      },
      event: {
        subscribe: async (params?: { directory?: string; workspace?: string }) => {
          calls.subscribed += 1
          calls.subscribeParams.push(params)
          async function* stream() {
            try {
              for (const event of events) yield event
            } finally {
              calls.returned += 1
            }
          }
          return { stream: stream() }
        },
      },
    } as unknown as ForgeClient
    return { client, calls }
  }

  async function readSse(res: Response): Promise<string> {
    return await res.text()
  }

  function seedRunningLoop(): void {
    createLoopsRepo(db!).insert(
      makeLoopRow({ projectId: 'p1', loopName: 'loop-a', currentSessionId: 'sess-live', worktreeDir: '/tmp/wt', workspaceId: 'wrk-1' }),
      { lastAuditResult: null },
    )
  }

  test('GET /api/loop/stream subscribes with the workspace, not just the directory', async () => {
    // Loop sessions are workspace-bound and the host's event bus is scoped per
    // workspace: a directory-only subscription silently receives no events.
    seedRunningLoop()
    const { client, calls } = makeFakeClient()
    const handler = createRequestHandler({ forgeDb: db!, client })

    const res = await handler(new Request('http://localhost/api/loop/stream?project=p1&loop=loop-a'))
    await res.text()

    expect(calls.subscribeParams).toEqual([{ directory: '/tmp/wt', workspace: 'wrk-1' }])
  })

  test('GET /api/loop/stream omits the workspace for a loop that has none', async () => {
    createLoopsRepo(db!).insert(
      makeLoopRow({ projectId: 'p1', loopName: 'no-ws', currentSessionId: 'sess-x', worktreeDir: '/tmp/wt2', workspaceId: null }),
      { lastAuditResult: null },
    )
    const { client, calls } = makeFakeClient()
    const handler = createRequestHandler({ forgeDb: db!, client })

    const res = await handler(new Request('http://localhost/api/loop/stream?project=p1&loop=no-ws'))
    await res.text()

    expect(calls.subscribeParams).toEqual([{ directory: '/tmp/wt2' }])
  })

  test('GET /api/loop/stream sends a snapshot then forwards events for that session only', async () => {
    seedRunningLoop()
    const { client, calls } = makeFakeClient([
      { type: 'message.part.updated', properties: { sessionID: 'sess-live', part: { id: 'p1', messageID: 'm1', type: 'text', text: 'hi' } } },
      { type: 'message.part.updated', properties: { sessionID: 'other-session', part: { id: 'p2', messageID: 'm2', type: 'text', text: 'nope' } } },
      { type: 'file.edited', properties: { file: 'a.ts' } },
      { type: 'session.idle', properties: { sessionID: 'sess-live' } },
    ])
    const handler = createRequestHandler({ forgeDb: db!, client })

    const res = await handler(new Request('http://localhost/api/loop/stream?project=p1&loop=loop-a'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)

    const body = await readSse(res)
    expect(body).toContain('event: snapshot')
    expect(body).toContain('sess-live')
    // Only the target session's events are forwarded, and only live types.
    expect(body).toContain('"text":"hi"')
    expect(body).not.toContain('other-session')
    expect(body).not.toContain('file.edited')
    expect(body).toContain('session.idle')

    expect(calls.messages).toEqual([{ sessionID: 'sess-live', directory: '/tmp/wt' }])
    expect(calls.subscribed).toBe(1)
  })

  test('GET /api/loop/stream returns 503 without a client and 404 for an unknown loop', async () => {
    seedRunningLoop()
    const noClient = createRequestHandler(makeDeps(db!))
    expect((await noClient(new Request('http://localhost/api/loop/stream?project=p1&loop=loop-a'))).status).toBe(503)

    const { client } = makeFakeClient()
    const withClient = createRequestHandler({ forgeDb: db!, client })
    expect((await withClient(new Request('http://localhost/api/loop/stream?project=p1&loop=ghost'))).status).toBe(404)
    expect((await withClient(new Request('http://localhost/api/loop/stream'))).status).toBe(404)
  })

  test('POST /api/loop/message prompts the loop\'s current session', async () => {
    seedRunningLoop()
    const { client, calls } = makeFakeClient()
    const handler = createRequestHandler({ forgeDb: db!, client, allowSend: true })

    const res = await handler(new Request('http://localhost/api/loop/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', loopName: 'loop-a', text: '  focus on tests  ' }),
    }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sessionId: 'sess-live' })
    expect(calls.prompts).toHaveLength(1)
    expect(calls.prompts[0].sessionID).toBe('sess-live')
    expect(calls.prompts[0].directory).toBe('/tmp/wt')
    expect(calls.prompts[0].parts).toEqual([{ type: 'text', text: 'focus on tests' }])
  })

  test('POST /api/loop/message is refused on a non-loopback bind', async () => {
    seedRunningLoop()
    const { client, calls } = makeFakeClient()
    const handler = createRequestHandler({ forgeDb: db!, client, allowSend: false })

    const res = await handler(new Request('http://localhost/api/loop/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', loopName: 'loop-a', text: 'hi' }),
    }))

    expect(res.status).toBe(403)
    expect(calls.prompts).toHaveLength(0)
  })

  test('POST /api/loop/message validates the body and the loop', async () => {
    seedRunningLoop()
    const { client } = makeFakeClient()
    const handler = createRequestHandler({ forgeDb: db!, client, allowSend: true })
    const post = (body: string) => handler(new Request('http://localhost/api/loop/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }))

    expect((await post('not-json')).status).toBe(400)
    expect((await post(JSON.stringify({ projectId: 'p1', loopName: 'loop-a', text: '   ' }))).status).toBe(400)
    expect((await post(JSON.stringify({ projectId: 'p1', loopName: 'loop-a', text: 'x'.repeat(10001) }))).status).toBe(400)
    expect((await post(JSON.stringify({ projectId: 'p1', loopName: 'ghost', text: 'hi' }))).status).toBe(404)
  })

  test('mutating routes reject content types a cross-origin form could send', async () => {
    seedRunningLoop()
    const { client } = makeFakeClient()
    const handler = createRequestHandler({ forgeDb: db!, client, allowSend: true })
    // A `text/plain` form body can be shaped into valid JSON and is sent
    // cross-origin without a preflight, so it must never reach the parser.
    const formBody = JSON.stringify({ projectId: 'p1', loopName: 'loop-a', text: 'hi' })

    for (const pathname of ['/api/loop/message', '/api/loop/models']) {
      expect((await handler(new Request('http://localhost' + pathname, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: formBody,
      }))).status).toBe(415)
      expect((await handler(new Request('http://localhost' + pathname, {
        method: 'POST',
        body: formBody,
      }))).status).toBe(415)
    }
  })

  test('POST /api/loop/message reports a host failure as 502', async () => {
    seedRunningLoop()
    const client = {
      session: {
        messages: async () => [],
        promptAsync: async () => { throw new Error('session is busy') },
      },
      event: { subscribe: async () => ({ stream: (async function* () {})() }) },
    } as unknown as ForgeClient
    const handler = createRequestHandler({ forgeDb: db!, client, allowSend: true })

    const res = await handler(new Request('http://localhost/api/loop/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', loopName: 'loop-a', text: 'hi' }),
    }))

    expect(res.status).toBe(502)
    expect(await res.text()).toContain('session is busy')
  })

  test('GET /api/loop/stream re-reads the transcript when the event bus is silent', async () => {
    // A loop driven by a different opencode process emits no events here, but
    // its transcript (shared storage) still advances. The stream must notice.
    seedRunningLoop()
    let reads = 0
    const client = {
      session: {
        messages: async () => {
          reads += 1
          return reads === 1
            ? [{ info: { id: 'm1', role: 'assistant' }, parts: [{ id: 'p1', messageID: 'm1', type: 'text', text: 'first' }] }]
            : [{ info: { id: 'm1', role: 'assistant' }, parts: [{ id: 'p1', messageID: 'm1', type: 'text', text: 'first' }, { id: 'p2', messageID: 'm1', type: 'text', text: 'second' }] }]
        },
        promptAsync: async () => {},
      },
      // A bus that stays open but never yields, like the wrong process.
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            await new Promise(resolve => setTimeout(resolve, 12000))
          })(),
        }),
      },
    } as unknown as ForgeClient
    const handler = createRequestHandler({ forgeDb: db!, client })

    const controller = new AbortController()
    const res = await handler(new Request('http://localhost/api/loop/stream?project=p1&loop=loop-a', {
      signal: controller.signal,
    }))

    // Read frames until the polled snapshot arrives (or the read budget ends).
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let body = ''
    const deadline = Date.now() + 9000
    while (Date.now() < deadline && !body.includes('"reason":"poll"')) {
      const { value, done } = await reader.read()
      if (done) break
      body += decoder.decode(value, { stream: true })
    }
    controller.abort()
    await reader.cancel().catch(() => {})

    expect(body).toContain('"reason":"initial"')
    expect(body).toContain('"reason":"poll"')
    expect(body).toContain('second')
    expect(reads).toBeGreaterThan(1)
  }, 15000)

  test('live routes reject the wrong method', async () => {
    const { client } = makeFakeClient()
    const handler = createRequestHandler({ forgeDb: db!, client, allowSend: true })
    expect((await handler(new Request('http://localhost/api/loop/stream', { method: 'POST' }))).status).toBe(404)
    expect((await handler(new Request('http://localhost/api/loop/message'))).status).toBe(404)
    expect((await handler(new Request('http://localhost/api/models', { method: 'POST' }))).status).toBe(404)
    expect((await handler(new Request('http://localhost/api/loop/models'))).status).toBe(404)
  })

  // ─── Cycle 11: model controls ─────────────────────────────────────────

  function makeModelClient(): ForgeClient {
    return {
      provider: {
        list: async () => ({
          connected: ['anthropic'],
          all: [
            {
              id: 'anthropic',
              name: 'Anthropic',
              models: {
                opus: { id: 'opus', name: 'Opus', variants: { 'thinking-max': { name: 'Thinking Max' }, off: { disabled: true } } },
              },
            },
            { id: 'unconnected', name: 'Nope', models: { x: { id: 'x', name: 'X' } } },
          ],
        }),
      },
    } as unknown as ForgeClient
  }

  test('GET /api/models lists connected providers with their variants', async () => {
    seedRunningLoop()
    const handler = createRequestHandler({ forgeDb: db!, client: makeModelClient() })

    const res = await handler(new Request('http://localhost/api/models?project=p1&loop=loop-a'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.models).toEqual([
      {
        id: 'anthropic/opus',
        name: 'Opus',
        provider: 'Anthropic',
        variants: [{ id: 'thinking-max', label: 'Thinking Max' }],
      },
    ])
  })

  test('GET /api/models returns 503 without a client', async () => {
    const handler = createRequestHandler(makeDeps(db!))
    expect((await handler(new Request('http://localhost/api/models'))).status).toBe(503)
  })

  test('POST /api/loop/models re-points the loop and reports the stored values', async () => {
    seedRunningLoop()
    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.setModelFailed('p1', 'loop-a', true)
    loopsRepo.advanceAuditorFallbackIndex('p1', 'loop-a', 0, 1)
    const handler = createRequestHandler({ forgeDb: db!, client: makeModelClient(), allowSend: true })

    const res = await handler(new Request('http://localhost/api/loop/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        loopName: 'loop-a',
        executionModel: 'anthropic/opus',
        executionVariant: 'thinking-max',
        auditorModel: 'anthropic/haiku',
      }),
    }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      executionModel: 'anthropic/opus',
      executionVariant: 'thinking-max',
      auditorModel: 'anthropic/haiku',
      auditorVariant: null,
    })

    // The two flags that would otherwise swallow the change are corrected.
    const stored = loopsRepo.get('p1', 'loop-a')!
    expect(stored.modelFailed).toBe(false)
    expect(stored.auditorFallbackIndex).toBe(0)
  })

  test('POST /api/loop/models validates model strings and the loop', async () => {
    seedRunningLoop()
    const handler = createRequestHandler({ forgeDb: db!, client: makeModelClient(), allowSend: true })
    const post = (body: unknown) => handler(new Request('http://localhost/api/loop/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }))

    expect((await post('not-json')).status).toBe(400)
    expect((await post({ loopName: 'loop-a', executionModel: 'a/b' })).status).toBe(400)
    expect((await post({ projectId: 'p1', loopName: 'ghost', executionModel: 'a/b' })).status).toBe(404)
    expect((await post({ projectId: 'p1', loopName: 'loop-a', executionModel: 'no-slash' })).status).toBe(400)
    expect((await post({ projectId: 'p1', loopName: 'loop-a', executionModel: 'a/b', executionVariant: 'has spaces' })).status).toBe(400)
    // Neither role provided is a no-op the caller should know about.
    expect((await post({ projectId: 'p1', loopName: 'loop-a' })).status).toBe(400)
  })

  test('POST /api/loop/models is refused on a non-loopback bind', async () => {
    seedRunningLoop()
    const before = createLoopsRepo(db!).get('p1', 'loop-a')!.executionModel
    const handler = createRequestHandler({ forgeDb: db!, client: makeModelClient(), allowSend: false })

    const res = await handler(new Request('http://localhost/api/loop/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', loopName: 'loop-a', executionModel: 'anthropic/opus' }),
    }))

    expect(res.status).toBe(403)
    expect(createLoopsRepo(db!).get('p1', 'loop-a')!.executionModel).toBe(before)
  })

  test('POST /api/loop/models clears a role back to the configured default with null', async () => {
    seedRunningLoop()
    const loopsRepo = createLoopsRepo(db!)
    loopsRepo.setModels('p1', 'loop-a', { executionModel: 'anthropic/opus' })
    const handler = createRequestHandler({ forgeDb: db!, client: makeModelClient(), allowSend: true })

    const res = await handler(new Request('http://localhost/api/loop/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', loopName: 'loop-a', executionModel: null }),
    }))

    expect(res.status).toBe(200)
    expect(loopsRepo.get('p1', 'loop-a')!.executionModel).toBeNull()
  })
})
