import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopEventsRepo, type LoopEventRow } from '../src/storage'

describe('LoopEventsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createLoopEventsRepo>
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-events-repo-test-'))
    db = new Database(join(tempDir, 'loop-events-repo-test.db'))

    // Mirror migration 138's loop_events table (no FK to loops; rows must
    // survive loop deletion).
    db.run(`
      CREATE TABLE loop_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL,
        run_started_at INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('coding_done','audit_done','final_audit_done','post_action_done','loop_terminated')),
        outcome TEXT,
        verdict TEXT CHECK (verdict IN ('clean','dirty') OR verdict IS NULL),
        iteration INTEGER,
        section_index INTEGER,
        session_id TEXT,
        role TEXT CHECK (role IN ('code','auditor') OR role IS NULL),
        model TEXT,
        cost REAL NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        findings_total INTEGER,
        findings_bugs INTEGER,
        detail TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_loop_events_loop ON loop_events(project_id, loop_name, run_started_at, id);
      CREATE INDEX IF NOT EXISTS idx_loop_events_created ON loop_events(created_at);
    `)

    repo = createLoopEventsRepo(db)
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  const projectId = 'test-project'
  const loopName = 'test-loop'
  const runStartedAt = 1_700_000_000_000

  function createEventRow(overrides?: Partial<Omit<LoopEventRow, 'id'>>): Omit<LoopEventRow, 'id'> {
    return {
      projectId,
      loopName,
      runStartedAt,
      eventType: 'coding_done',
      outcome: 'section_complete',
      verdict: null,
      iteration: 1,
      sectionIndex: 0,
      sessionId: 'session-1',
      role: 'code',
      model: 'claude-sonnet-4-20250514',
      cost: 0.002,
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 300,
      messageCount: 5,
      findingsTotal: null,
      findingsBugs: null,
      detail: null,
      createdAt: Date.now(),
      ...overrides,
    }
  }

  describe('insert + listByLoop round-trip', () => {
    test('inserts and lists a row with all fields round-tripped', () => {
      const row = createEventRow()
      repo.insert(row)

      const rows = repo.listByLoop(projectId, loopName)
      expect(rows).toHaveLength(1)
      const got = rows[0]
      expect(got.id).toBe(1)
      expect(got.projectId).toBe(projectId)
      expect(got.loopName).toBe(loopName)
      expect(got.runStartedAt).toBe(runStartedAt)
      expect(got.eventType).toBe('coding_done')
      expect(got.outcome).toBe('section_complete')
      expect(got.verdict).toBeNull()
      expect(got.iteration).toBe(1)
      expect(got.sectionIndex).toBe(0)
      expect(got.sessionId).toBe('session-1')
      expect(got.role).toBe('code')
      expect(got.model).toBe('claude-sonnet-4-20250514')
      expect(got.cost).toBe(0.002)
      expect(got.inputTokens).toBe(1000)
      expect(got.outputTokens).toBe(500)
      expect(got.reasoningTokens).toBe(100)
      expect(got.cacheReadTokens).toBe(200)
      expect(got.cacheWriteTokens).toBe(300)
      expect(got.messageCount).toBe(5)
      expect(got.findingsTotal).toBeNull()
      expect(got.findingsBugs).toBeNull()
      expect(got.detail).toBeNull()
      expect(got.createdAt).toBe(row.createdAt)
    })

    test('round-trips null verdict and null section_index via audit_done', () => {
      const row = createEventRow({
        eventType: 'audit_done',
        verdict: null,
        sectionIndex: null,
        findingsTotal: 3,
        findingsBugs: 1,
      })
      repo.insert(row)

      const got = repo.listByLoop(projectId, loopName)[0]
      expect(got.eventType).toBe('audit_done')
      expect(got.verdict).toBeNull()
      expect(got.sectionIndex).toBeNull()
      expect(got.findingsTotal).toBe(3)
      expect(got.findingsBugs).toBe(1)
    })

    test('round-trips a clean verdict and a non-null section_index', () => {
      const row = createEventRow({
        eventType: 'audit_done',
        verdict: 'clean',
        sectionIndex: 2,
      })
      repo.insert(row)

      const got = repo.listByLoop(projectId, loopName)[0]
      expect(got.verdict).toBe('clean')
      expect(got.sectionIndex).toBe(2)
    })

    test('round-trips final_audit_done and loop_terminated event types', () => {
      repo.insert(createEventRow({ eventType: 'final_audit_done', verdict: 'dirty' }))
      repo.insert(createEventRow({ eventType: 'loop_terminated', outcome: 'max_iterations' }))

      const rows = repo.listByLoop(projectId, loopName)
      expect(rows.map(r => r.eventType)).toEqual(['final_audit_done', 'loop_terminated'])
      expect(rows[0].verdict).toBe('dirty')
      expect(rows[1].outcome).toBe('max_iterations')
    })
  })

  describe('listByLoop scoping and ordering', () => {
    test('scopes by run_started_at when provided', () => {
      repo.insert(createEventRow({ runStartedAt: 100, iteration: 1 }))
      repo.insert(createEventRow({ runStartedAt: 200, iteration: 1 }))

      const scoped = repo.listByLoop(projectId, loopName, 100)
      expect(scoped).toHaveLength(1)
      expect(scoped[0].runStartedAt).toBe(100)
    })

    test('returns rows from all runs when run_started_at is omitted', () => {
      repo.insert(createEventRow({ runStartedAt: 100 }))
      repo.insert(createEventRow({ runStartedAt: 200 }))

      const all = repo.listByLoop(projectId, loopName)
      expect(all).toHaveLength(2)
    })

    test('orders rows by id ASC across mixed runs', () => {
      repo.insert(createEventRow({ runStartedAt: 200 }))
      repo.insert(createEventRow({ runStartedAt: 100 }))
      repo.insert(createEventRow({ runStartedAt: 200 }))

      const all = repo.listByLoop(projectId, loopName)
      expect(all.map(r => r.id)).toEqual([1, 2, 3])
    })

    test('scopes by project_id and loop_name', () => {
      repo.insert(createEventRow({ loopName: 'loop-a' }))
      repo.insert(createEventRow({ loopName: 'loop-b', projectId: 'other-project' }))

      const a = repo.listByLoop(projectId, 'loop-a')
      expect(a).toHaveLength(1)
      expect(a[0].loopName).toBe('loop-a')

      const b = repo.listByLoop('other-project', 'loop-b')
      expect(b).toHaveLength(1)
      expect(b[0].loopName).toBe('loop-b')

      expect(repo.listByLoop(projectId, 'loop-b')).toHaveLength(0)
    })
  })

  describe('auditCountsForRun', () => {
    test('counts clean, dirty, and section_retry outcomes scoped to a run', () => {
      // Run A (the one we query)
      repo.insert(createEventRow({ runStartedAt: 100, eventType: 'audit_done', verdict: 'clean' }))
      repo.insert(createEventRow({ runStartedAt: 100, eventType: 'audit_done', verdict: 'dirty' }))
      repo.insert(createEventRow({ runStartedAt: 100, eventType: 'final_audit_done', verdict: 'clean' }))
      repo.insert(createEventRow({ runStartedAt: 100, eventType: 'coding_done', outcome: 'section_retry' }))
      repo.insert(createEventRow({ runStartedAt: 100, eventType: 'audit_done', verdict: 'dirty' }))

      // Run B (must be excluded)
      repo.insert(createEventRow({ runStartedAt: 200, eventType: 'audit_done', verdict: 'clean' }))
      repo.insert(createEventRow({ runStartedAt: 200, eventType: 'coding_done', outcome: 'section_retry' }))

      const counts = repo.auditCountsForRun(projectId, loopName, 100)
      expect(counts.cleanAudits).toBe(2) // audit_done+clean + final_audit_done+clean
      expect(counts.dirtyAudits).toBe(2)
      expect(counts.sectionRetries).toBe(1)
    })

    test('ignores audit_done rows with null verdict', () => {
      repo.insert(createEventRow({ runStartedAt: 100, eventType: 'audit_done', verdict: null }))
      repo.insert(createEventRow({ runStartedAt: 100, eventType: 'audit_done', verdict: 'clean' }))

      const counts = repo.auditCountsForRun(projectId, loopName, 100)
      expect(counts.cleanAudits).toBe(1)
      expect(counts.dirtyAudits).toBe(0)
      expect(counts.sectionRetries).toBe(0)
    })

    test('counts only section_retry outcomes across all event types', () => {
      repo.insert(createEventRow({ runStartedAt: 100, eventType: 'coding_done', outcome: 'section_complete' }))
      repo.insert(createEventRow({ runStartedAt: 100, eventType: 'final_audit_done', outcome: 'section_retry' }))
      repo.insert(createEventRow({ runStartedAt: 100, eventType: 'audit_done', outcome: 'section_retry', verdict: 'clean' }))

      const counts = repo.auditCountsForRun(projectId, loopName, 100)
      expect(counts.sectionRetries).toBe(2)
      expect(counts.cleanAudits).toBe(1)
    })

    test('returns zeros for an empty run', () => {
      const counts = repo.auditCountsForRun(projectId, loopName, 999)
      expect(counts).toEqual({ cleanAudits: 0, dirtyAudits: 0, sectionRetries: 0 })
    })
  })

  describe('sweepOlderThan', () => {
    test('deletes only rows with created_at older than the cutoff', () => {
      repo.insert(createEventRow({ createdAt: 1000 }))
      repo.insert(createEventRow({ createdAt: 2000 }))
      repo.insert(createEventRow({ createdAt: 3000 }))

      const deleted = repo.sweepOlderThan(2500)
      expect(deleted).toBe(2)

      const remaining = repo.listByLoop(projectId, loopName)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].createdAt).toBe(3000)
    })

    test('returns 0 when nothing matches', () => {
      repo.insert(createEventRow({ createdAt: 5000 }))
      expect(repo.sweepOlderThan(4000)).toBe(0)
      expect(repo.listByLoop(projectId, loopName)).toHaveLength(1)
    })

    test('returns 0 on an empty table', () => {
      expect(repo.sweepOlderThan(Date.now())).toBe(0)
    })

    test('does not delete rows at the exact cutoff (strict <)', () => {
      repo.insert(createEventRow({ createdAt: 1000 }))
      expect(repo.sweepOlderThan(1000)).toBe(0)
      expect(repo.listByLoop(projectId, loopName)).toHaveLength(1)
    })
  })
})
