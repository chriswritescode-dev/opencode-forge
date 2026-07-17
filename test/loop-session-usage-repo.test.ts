import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { createLoopSessionUsageRepo, type LoopSessionUsageRow } from '../src/storage'

const TEST_DIR = '/tmp/opencode-loop-session-usage-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE loops (
      project_id           TEXT NOT NULL,
      loop_name            TEXT NOT NULL,
      status               TEXT NOT NULL,
      current_session_id   TEXT NOT NULL,
      worktree             INTEGER NOT NULL,
      worktree_dir         TEXT NOT NULL,
      worktree_branch      TEXT,
      project_dir          TEXT NOT NULL,
      max_iterations       INTEGER NOT NULL,
      iteration            INTEGER NOT NULL DEFAULT 0,
      audit_count          INTEGER NOT NULL DEFAULT 0,
      error_count          INTEGER NOT NULL DEFAULT 0,
      phase                TEXT NOT NULL,
      execution_model      TEXT,
      auditor_model        TEXT,
      model_failed         INTEGER NOT NULL DEFAULT 0,
      sandbox              INTEGER NOT NULL DEFAULT 0,
      sandbox_container    TEXT,
      started_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      termination_reason   TEXT,
      completion_summary   TEXT,
      workspace_id         TEXT,
      host_session_id      TEXT,
      current_section_index INTEGER NOT NULL DEFAULT 0,
      total_sections       INTEGER NOT NULL DEFAULT 0,
      final_audit_done     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, loop_name)
    );

    CREATE TABLE loop_session_usage (
      project_id        TEXT NOT NULL,
      loop_name         TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      role              TEXT NOT NULL CHECK(role IN ('code', 'auditor', 'unknown')),
      model             TEXT NOT NULL,
      cost              REAL NOT NULL DEFAULT 0,
      input_tokens      INTEGER NOT NULL DEFAULT 0,
      output_tokens     INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      message_count     INTEGER NOT NULL DEFAULT 0,
      captured_at       INTEGER NOT NULL,
      run_started_at    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, loop_name, session_id, model),
      FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
    );

    CREATE INDEX idx_loop_session_usage_project_loop ON loop_session_usage(project_id, loop_name);
    CREATE INDEX idx_loop_session_usage_run ON loop_session_usage(project_id, loop_name, run_started_at);
  `)
  return db
}

describe('LoopSessionUsageRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createLoopSessionUsageRepo>
  const projectId = 'test-project'
  const loopName = 'test-loop'

  beforeEach(() => {
    db = createTestDb()
    db.run('PRAGMA foreign_keys = ON')
    // Insert parent loop row to satisfy FK constraint
    db.run(`
      INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, phase, started_at)
      VALUES (?, ?, 'active', 'session-1', 1, '/tmp/test', '/tmp/test', 10, 0, 'running', ?)
    `, [projectId, loopName, Date.now()])
    repo = createLoopSessionUsageRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  function createUsageRow(overrides?: Partial<LoopSessionUsageRow>): LoopSessionUsageRow {
    return {
      projectId,
      loopName,
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
      capturedAt: Date.now(),
      // Default run identity matches the loop row's seeded started_at; tests that
      // exercise run isolation override this with a per-run value.
      runStartedAt: 1_700_000_000_000,
      ...overrides,
    }
  }

  describe('upsertSessionUsage', () => {
    test('inserts new session usage', () => {
      const row = createUsageRow()
      repo.upsertSessionUsage(row)

      const rows = repo.listSessionUsage(projectId, loopName)
      expect(rows).toHaveLength(1)
      expect(rows[0].sessionId).toBe('session-1')
      expect(rows[0].model).toBe('claude-sonnet-4-20250514')
      expect(rows[0].inputTokens).toBe(1000)
    })

    test('replacing session deletes old rows before inserting new ones', () => {
      const row1 = createUsageRow({ sessionId: 'session-1', model: 'model-a', inputTokens: 1000 })
      const row2 = createUsageRow({ sessionId: 'session-1', model: 'model-a', inputTokens: 2000, capturedAt: Date.now() + 1 })
      
      repo.upsertSessionUsage(row1)
      repo.upsertSessionUsage(row2)

      const rows = repo.listSessionUsage(projectId, loopName)
      expect(rows).toHaveLength(1)
      
      expect(rows[0].inputTokens).toBe(2000)
    })

    test('recapturing same session replaces old rows completely', () => {
      const row1 = createUsageRow({ sessionId: 'session-1', model: 'model-a', inputTokens: 1000 })
      repo.upsertSessionUsage(row1)

      const row2 = createUsageRow({ sessionId: 'session-1', model: 'model-a', inputTokens: 5000 })
      repo.upsertSessionUsage(row2)

      const rows = repo.listSessionUsage(projectId, loopName)
      expect(rows).toHaveLength(1)
      expect(rows[0].inputTokens).toBe(5000)
    })

    test('accepts array of rows for batch upsert', () => {
      const rows = [
        createUsageRow({ sessionId: 'session-1', model: 'model-a', inputTokens: 1000 }),
        createUsageRow({ sessionId: 'session-1', model: 'model-b', inputTokens: 2000 }),
      ]
      repo.upsertSessionUsage(rows)

      const result = repo.listSessionUsage(projectId, loopName)
      expect(result).toHaveLength(2)
      expect(result.map(r => r.model).sort()).toEqual(['model-a', 'model-b'])
      expect(result.find(r => r.model === 'model-a')?.inputTokens).toBe(1000)
      expect(result.find(r => r.model === 'model-b')?.inputTokens).toBe(2000)
    })

    test('batch upsert replaces all rows for a session atomically', () => {
      const initialRows = [
        createUsageRow({ sessionId: 'session-1', model: 'model-a', inputTokens: 1000 }),
        createUsageRow({ sessionId: 'session-1', model: 'model-b', inputTokens: 2000 }),
      ]
      repo.upsertSessionUsage(initialRows)

      const replacementRows = [
        createUsageRow({ sessionId: 'session-1', model: 'model-a', inputTokens: 5000 }),
        createUsageRow({ sessionId: 'session-1', model: 'model-c', inputTokens: 3000 }),
      ]
      repo.upsertSessionUsage(replacementRows)

      const result = repo.listSessionUsage(projectId, loopName)
      expect(result).toHaveLength(2)
      expect(result.map(r => r.model).sort()).toEqual(['model-a', 'model-c'])
      expect(result.find(r => r.model === 'model-a')?.inputTokens).toBe(5000)
      expect(result.find(r => r.model === 'model-c')?.inputTokens).toBe(3000)
    })
  })

  describe('getAggregate', () => {
    test('returns null when no usage exists', () => {
      const agg = repo.getAggregate(projectId, loopName)
      expect(agg).toBeNull()
    })

    test('aggregates two sessions into one loop total', () => {
      const row1 = createUsageRow({ sessionId: 'session-1', model: 'model-a', inputTokens: 1000, outputTokens: 500 })
      const row2 = createUsageRow({ sessionId: 'session-2', model: 'model-a', inputTokens: 2000, outputTokens: 1000 })
      
      repo.upsertSessionUsage(row1)
      repo.upsertSessionUsage(row2)

      const agg = repo.getAggregate(projectId, loopName)
      expect(agg).toBeDefined()
      expect(agg?.loopName).toBe(loopName)
      expect(agg?.totalInputTokens).toBe(3000)
      expect(agg?.totalOutputTokens).toBe(1500)
      expect(agg?.totalMessageCount).toBe(10)
    })

    test('groups by model correctly', () => {
      const row1 = createUsageRow({ sessionId: 'session-1', model: 'model-a', inputTokens: 1000 })
      const row2 = createUsageRow({ sessionId: 'session-2', model: 'model-a', inputTokens: 2000 })
      const row3 = createUsageRow({ sessionId: 'session-3', model: 'model-b', inputTokens: 5000 })
      
      repo.upsertSessionUsage(row1)
      repo.upsertSessionUsage(row2)
      repo.upsertSessionUsage(row3)

      const agg = repo.getAggregate(projectId, loopName)
      expect(agg).toBeDefined()
      expect(agg?.totalInputTokens).toBe(8000)
      expect(agg?.byModel['model-a']).toBeDefined()
      expect(agg?.byModel['model-a'].inputTokens).toBe(3000)
      expect(agg?.byModel['model-b']).toBeDefined()
      expect(agg?.byModel['model-b'].inputTokens).toBe(5000)
    })

    test('byModel includes all models from same session', () => {
      const rows = [
        createUsageRow({ sessionId: 'session-1', model: 'model-a', inputTokens: 1000, outputTokens: 500 }),
        createUsageRow({ sessionId: 'session-1', model: 'model-b', inputTokens: 2000, outputTokens: 1000 }),
      ]
      repo.upsertSessionUsage(rows)

      const agg = repo.getAggregate(projectId, loopName)
      expect(agg).toBeDefined()
      expect(agg?.totalInputTokens).toBe(3000)
      expect(agg?.totalOutputTokens).toBe(1500)
      expect(agg?.byModel['model-a']).toBeDefined()
      expect(agg?.byModel['model-a'].inputTokens).toBe(1000)
      expect(agg?.byModel['model-b']).toBeDefined()
      expect(agg?.byModel['model-b'].inputTokens).toBe(2000)
    })

    test('aggregates all token types correctly', () => {
      const row1 = createUsageRow({
        sessionId: 'session-1',
        model: 'model-a',
        inputTokens: 1000,
        outputTokens: 500,
        reasoningTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 300,
        cost: 0.01,
        messageCount: 5,
      })
      const row2 = createUsageRow({
        sessionId: 'session-2',
        model: 'model-a',
        inputTokens: 2000,
        outputTokens: 1000,
        reasoningTokens: 200,
        cacheReadTokens: 400,
        cacheWriteTokens: 600,
        cost: 0.02,
        messageCount: 10,
      })
      
      repo.upsertSessionUsage(row1)
      repo.upsertSessionUsage(row2)

      const agg = repo.getAggregate(projectId, loopName)
      expect(agg?.totalInputTokens).toBe(3000)
      expect(agg?.totalOutputTokens).toBe(1500)
      expect(agg?.totalReasoningTokens).toBe(300)
      expect(agg?.totalCacheReadTokens).toBe(600)
      expect(agg?.totalCacheWriteTokens).toBe(900)
      expect(agg?.totalCost).toBe(0.03)
      expect(agg?.totalMessageCount).toBe(15)
    })
  })

  describe('getAggregateForRun', () => {
    test('returns null when no usage exists for the run', () => {
      const agg = repo.getAggregateForRun(projectId, loopName, 1_700_000_000_000)
      expect(agg).toBeNull()
    })

    test('includes only rows whose run_started_at exactly matches (restart isolation)', () => {
      // Run 1 and run 2 share the same loop_name but stamp different
      // run_started_at values at capture time. Aggregation by equality keeps
      // each run isolated even though both runs' rows coexist in the table.
      repo.upsertSessionUsage(createUsageRow({
        sessionId: 'run1-session-a',
        model: 'model-a',
        inputTokens: 1000,
        outputTokens: 500,
        runStartedAt: 1000,
        capturedAt: 1500,
      }))
      repo.upsertSessionUsage(createUsageRow({
        sessionId: 'run1-session-b',
        model: 'model-b',
        inputTokens: 2000,
        outputTokens: 1000,
        runStartedAt: 1000,
        capturedAt: 1600,
      }))

      const run1 = repo.getAggregateForRun(projectId, loopName, 1000)
      expect(run1?.totalInputTokens).toBe(3000)
      expect(run1?.totalOutputTokens).toBe(1500)

      // Restart: run 1's rows remain; run 2 captures a fresh, smaller row
      // under a new session id, stamping run 2's started_at.
      repo.upsertSessionUsage(createUsageRow({
        sessionId: 'run2-session-a',
        model: 'model-a',
        inputTokens: 3000,
        outputTokens: 1500,
        runStartedAt: 2000,
        capturedAt: 2500,
      }))

      // Run 2 aggregate must include ONLY run 2's rows — prior-run rows
      // stamp run_started_at = 1000, which does not equal 2000.
      const run2 = repo.getAggregateForRun(projectId, loopName, 2000)
      expect(run2?.totalInputTokens).toBe(3000)
      expect(run2?.totalOutputTokens).toBe(1500)
      expect(run2?.byModel['model-a'].inputTokens).toBe(3000)
      expect(run2?.byModel['model-b']).toBeUndefined()
    })

    test('restart with equal-millisecond capturedAt still isolates by run identity', () => {
      // Regression for the auditor's timestamp-collision finding.
      //
      // Original bug: run aggregation filtered `captured_at >= runStartedAt`.
      // If a prior run captured usage in the same Date.now() millisecond as
      // the restarted run's startedAt, the new run folded the prior run's row
      // into its aggregate.
      //
      // Fix: every usage row stamps run_started_at from the loop's started_at
      // at capture time, and aggregation filters by equality on that column.
      // captured_at collisions no longer matter because the row's run identity
      // is preserved independently of when it was captured.

      // Prior run: startedAt = 1000, captured usage in the same ms as the
      // restarted run's startedAt (1001). Under the old filter this row would
      // leak into run 2's aggregate (1001 >= 1001).
      repo.upsertSessionUsage(createUsageRow({
        sessionId: 'run1-session',
        model: 'model-b',
        inputTokens: 9999,
        runStartedAt: 1000,
        capturedAt: 1001,
      }))

      // Restarted run: new startedAt identity (1001). Captures its own usage.
      repo.upsertSessionUsage(createUsageRow({
        sessionId: 'run2-session',
        model: 'model-a',
        inputTokens: 2000,
        runStartedAt: 1001,
        capturedAt: 1001,
      }))

      // Run 2's aggregate must include ONLY its own row — the prior-run row
      // stamps run_started_at = 1000 (run 1's identity), not 1001, so it is
      // excluded despite the captured_at collision.
      const run2 = repo.getAggregateForRun(projectId, loopName, 1001)
      expect(run2?.totalInputTokens).toBe(2000)
      expect(run2?.byModel['model-a'].inputTokens).toBe(2000)
      expect(run2?.byModel['model-b']).toBeUndefined()
    })

    test('matched row stamps run_started_at exactly equal to the queried run identity', () => {
      repo.upsertSessionUsage(createUsageRow({
        sessionId: 'session-exact',
        model: 'model-a',
        inputTokens: 1000,
        runStartedAt: 1234,
      }))

      const agg = repo.getAggregateForRun(projectId, loopName, 1234)
      expect(agg?.totalInputTokens).toBe(1000)
    })

    test('excludes rows stamped with a different run_started_at', () => {
      repo.upsertSessionUsage(createUsageRow({
        sessionId: 'prior-run-session',
        model: 'model-a',
        inputTokens: 5000,
        runStartedAt: 999, // different run
        capturedAt: 999,
      }))

      const agg = repo.getAggregateForRun(projectId, loopName, 1000)
      expect(agg).toBeNull()
    })
  })

  describe('listSessionUsage', () => {
    test('returns empty array when no usage exists', () => {
      const rows = repo.listSessionUsage(projectId, loopName)
      expect(rows).toHaveLength(0)
    })

    test('returns all usage rows for a loop', () => {
      const row1 = createUsageRow({ sessionId: 'session-1', model: 'model-a' })
      const row2 = createUsageRow({ sessionId: 'session-2', model: 'model-b' })
      const row3 = createUsageRow({ sessionId: 'session-3', model: 'model-c' })
      
      repo.upsertSessionUsage(row1)
      repo.upsertSessionUsage(row2)
      repo.upsertSessionUsage(row3)

      const rows = repo.listSessionUsage(projectId, loopName)
      expect(rows).toHaveLength(3)
    })
  })

  describe('hasSession', () => {
    test('returns false when session does not exist', () => {
      expect(repo.hasSession(projectId, loopName, 'non-existent')).toBe(false)
    })

    test('returns true when session exists', () => {
      const row = createUsageRow({ sessionId: 'session-123' })
      repo.upsertSessionUsage(row)
      
      expect(repo.hasSession(projectId, loopName, 'session-123')).toBe(true)
    })

    test('returns false for different loop with same session id', () => {
      // Insert parent loop rows for loop-a and loop-b
      db.run(`
        INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, phase, started_at)
        VALUES (?, ?, 'active', 'session-1', 1, '/tmp/test', '/tmp/test', 10, 0, 'running', ?)
      `, [projectId, 'loop-a', Date.now()])
      db.run(`
        INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, phase, started_at)
        VALUES (?, ?, 'active', 'session-1', 1, '/tmp/test', '/tmp/test', 10, 0, 'running', ?)
      `, [projectId, 'loop-b', Date.now()])
      
      const row = createUsageRow({ sessionId: 'session-123', loopName: 'loop-a' })
      repo.upsertSessionUsage(row)
      
      expect(repo.hasSession(projectId, 'loop-b', 'session-123')).toBe(false)
    })
  })

  describe('deleteLoop', () => {
    test('deletes all usage rows for a loop', () => {
      // Insert parent loop rows for loop-a and loop-b
      db.run(`
        INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, phase, started_at)
        VALUES (?, ?, 'active', 'session-1', 1, '/tmp/test', '/tmp/test', 10, 0, 'running', ?)
      `, [projectId, 'loop-a', Date.now()])
      db.run(`
        INSERT INTO loops (project_id, loop_name, status, current_session_id, worktree, worktree_dir, project_dir, max_iterations, iteration, phase, started_at)
        VALUES (?, ?, 'active', 'session-1', 1, '/tmp/test', '/tmp/test', 10, 0, 'running', ?)
      `, [projectId, 'loop-b', Date.now()])
      
      const row1 = createUsageRow({ sessionId: 'session-1', loopName: 'loop-a' })
      const row2 = createUsageRow({ sessionId: 'session-2', loopName: 'loop-a' })
      const row3 = createUsageRow({ sessionId: 'session-1', loopName: 'loop-b' })
      
      repo.upsertSessionUsage(row1)
      repo.upsertSessionUsage(row2)
      repo.upsertSessionUsage(row3)

      repo.deleteLoop(projectId, 'loop-a')

      const rowsLoopA = repo.listSessionUsage(projectId, 'loop-a')
      const rowsLoopB = repo.listSessionUsage(projectId, 'loop-b')
      
      expect(rowsLoopA).toHaveLength(0)
      expect(rowsLoopB).toHaveLength(1)
    })

    test('does not error on non-existent loop', () => {
      expect(() => repo.deleteLoop(projectId, 'non-existent')).not.toThrow()
    })

    test('usage rows are cascade-deleted when parent loop row is deleted', () => {
      // Insert usage rows (parent loop already exists from beforeEach)
      const row1 = createUsageRow({ sessionId: 'session-1', loopName })
      const row2 = createUsageRow({ sessionId: 'session-2', loopName })
      repo.upsertSessionUsage(row1)
      repo.upsertSessionUsage(row2)
      
      // Verify usage exists
      expect(repo.listSessionUsage(projectId, loopName)).toHaveLength(2)
      
      // Delete parent loop row directly (not via repo)
      db.run('DELETE FROM loops WHERE project_id = ? AND loop_name = ?', [projectId, loopName])
      
      // Verify usage rows were cascade-deleted by FK constraint
      const remainingUsage = repo.listSessionUsage(projectId, loopName)
      expect(remainingUsage).toHaveLength(0)
    })
  })

  describe('role field validation', () => {
    test('accepts code role', () => {
      const row = createUsageRow({ role: 'code' })
      expect(() => repo.upsertSessionUsage(row)).not.toThrow()
    })

    test('accepts auditor role', () => {
      const row = createUsageRow({ role: 'auditor' })
      expect(() => repo.upsertSessionUsage(row)).not.toThrow()
    })

    test('accepts unknown role', () => {
      const row = createUsageRow({ role: 'unknown' })
      expect(() => repo.upsertSessionUsage(row)).not.toThrow()
    })
  })
})
