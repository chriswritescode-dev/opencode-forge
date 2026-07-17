import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopRunsRepo, type LoopRunRow } from '../src/storage'

describe('LoopRunsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createLoopRunsRepo>
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-runs-repo-test-'))
    db = new Database(join(tempDir, 'loop-runs-repo-test.db'))

    // Mirror migration 138's loop_runs table (PK: project_id, loop_name, started_at).
    db.run(`
      CREATE TABLE loop_runs (
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        termination_reason TEXT,
        loop_kind TEXT NOT NULL DEFAULT 'plan',
        execution_model TEXT,
        auditor_model TEXT,
        execution_variant TEXT,
        auditor_variant TEXT,
        iterations INTEGER NOT NULL DEFAULT 0,
        audit_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        total_sections INTEGER NOT NULL DEFAULT 0,
        section_retries INTEGER NOT NULL DEFAULT 0,
        clean_audits INTEGER NOT NULL DEFAULT 0,
        dirty_audits INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, loop_name, started_at)
      );
      CREATE INDEX IF NOT EXISTS idx_loop_runs_created ON loop_runs(created_at);
    `)

    repo = createLoopRunsRepo(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function sampleRow(overrides: Partial<LoopRunRow> = {}): LoopRunRow {
    return {
      projectId: 'proj1',
      loopName: 'loop-a',
      startedAt: 1000,
      completedAt: 2000,
      status: 'completed',
      terminationReason: null,
      loopKind: 'plan',
      executionModel: 'exec-model',
      auditorModel: 'audit-model',
      executionVariant: null,
      auditorVariant: null,
      iterations: 5,
      auditCount: 3,
      errorCount: 1,
      totalSections: 0,
      sectionRetries: 0,
      cleanAudits: 2,
      dirtyAudits: 1,
      cost: 0.5,
      inputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 20,
      messageCount: 7,
      durationMs: 1000,
      createdAt: 2500,
      ...overrides,
    }
  }

  test('upsert then listByProject round-trips a full LoopRunRow', () => {
    const row = sampleRow()
    repo.upsert(row)

    const rows = repo.listByProject('proj1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(row)
  })

  test('second upsert with same PK replaces the row', () => {
    repo.upsert(sampleRow({ status: 'running', completedAt: null, iterations: 1 }))
    repo.upsert(sampleRow({ status: 'completed', completedAt: 2000, iterations: 5, errorCount: 2 }))

    const rows = repo.listByProject('proj1')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('completed')
    expect(rows[0].completedAt).toBe(2000)
    expect(rows[0].iterations).toBe(5)
    expect(rows[0].errorCount).toBe(2)
  })

  test('listByProject orders by started_at DESC and scopes to project', () => {
    repo.upsert(sampleRow({ loopName: 'old', startedAt: 100, completedAt: 200 }))
    repo.upsert(sampleRow({ loopName: 'newest', startedAt: 300, completedAt: 400 }))
    repo.upsert(sampleRow({ loopName: 'mid', startedAt: 200, completedAt: 300 }))
    repo.upsert(sampleRow({ projectId: 'proj2', loopName: 'other', startedAt: 999, completedAt: 1000 }))

    const rows = repo.listByProject('proj1')
    expect(rows.map((r) => r.loopName)).toEqual(['newest', 'mid', 'old'])
  })

  test('listProjectIds returns distinct project ids', () => {
    repo.upsert(sampleRow({ projectId: 'proj1', loopName: 'a', startedAt: 100 }))
    repo.upsert(sampleRow({ projectId: 'proj2', loopName: 'b', startedAt: 100 }))
    repo.upsert(sampleRow({ projectId: 'proj1', loopName: 'c', startedAt: 200 }))

    const ids = repo.listProjectIds().sort()
    expect(ids).toEqual(['proj1', 'proj2'])
  })

  test('sweepOlderThan deletes rows with created_at older than cutoff and returns count', () => {
    repo.upsert(sampleRow({ loopName: 'old', startedAt: 100, completedAt: 200, createdAt: 1000 }))
    repo.upsert(sampleRow({ loopName: 'new', startedAt: 300, completedAt: 400, createdAt: 5000 }))

    const deleted = repo.sweepOlderThan(3000)
    expect(deleted).toBe(1)

    const rows = repo.listByProject('proj1')
    expect(rows.map((r) => r.loopName)).toEqual(['new'])
  })
})
