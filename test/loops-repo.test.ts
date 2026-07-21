import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { createLoopsRepo, type LoopRow, type LoopLargeFields } from '../src/storage/repos/loops-repo'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('LoopsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createLoopsRepo>
  let dbPath: string
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loops-repo-test-'))
    dbPath = join(tempDir, 'loops-repo-test.db')
    db = new Database(dbPath)
    
    // Create the tables
    db.run(`
      CREATE TABLE loops (
        project_id           TEXT NOT NULL,
        loop_name            TEXT NOT NULL,
        status               TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
        current_session_id   TEXT NOT NULL,
        worktree             INTEGER NOT NULL,
        worktree_dir         TEXT NOT NULL,
        session_directory    TEXT,
        worktree_branch      TEXT,
        project_dir          TEXT NOT NULL,
        max_iterations       INTEGER NOT NULL,
        iteration            INTEGER NOT NULL DEFAULT 0,
        audit_count          INTEGER NOT NULL DEFAULT 0,
        error_count          INTEGER NOT NULL DEFAULT 0,
        phase                TEXT NOT NULL CHECK(phase IN ('coding','auditing','final_auditing','post_action','final_audit_fix')),
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
        audit_session_id     TEXT,
        current_section_index INTEGER NOT NULL DEFAULT 0,
        total_sections INTEGER NOT NULL DEFAULT 0,
        final_audit_done INTEGER NOT NULL DEFAULT 0,
        final_audit_attempts INTEGER NOT NULL DEFAULT 0,
      execution_variant    TEXT,
      auditor_variant      TEXT,
      loop_kind            TEXT NOT NULL DEFAULT 'plan',
      executor_session_id  TEXT,
      PRIMARY KEY (project_id, loop_name)
      )
    `)
    
    db.run(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
        last_audit_result   TEXT,
        post_action_report  TEXT,
        goal                TEXT,
        PRIMARY KEY (project_id, loop_name),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)
    
    db.run(`CREATE UNIQUE INDEX idx_loops_session ON loops(project_id, current_session_id) WHERE status = 'running'`)
    db.run(`CREATE INDEX idx_loops_executor_session ON loops(project_id, executor_session_id) WHERE status = 'running' AND executor_session_id IS NOT NULL`)
    
    repo = createLoopsRepo(db)
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  const testRow: LoopRow = {
    projectId: 'test-project',
    loopName: 'test-loop',
    status: 'running',
    currentSessionId: 'session-1',
    worktree: false,
    worktreeDir: '/tmp/test',
    worktreeBranch: null,
    projectDir: '/tmp/test',
    maxIterations: 10,
    iteration: 1,
    auditCount: 0,
    errorCount: 0,
    phase: 'coding',
    executionModel: null,
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
    totalSections: 0,
    finalAuditDone: 0,
    executionVariant: null,
    auditorVariant: null,
    kind: 'plan',
  }

  const testLarge: LoopLargeFields = {
    lastAuditResult: null,
  }

  describe('insert + get roundtrip', () => {
    test('should insert and retrieve a loop row', () => {
      repo.insert(testRow, testLarge)
      
      const retrieved = repo.get(testRow.projectId, testRow.loopName)
      expect(retrieved).toBeTruthy()
      expect(retrieved!.loopName).toBe(testRow.loopName)
      expect(retrieved!.status).toBe('running')
      expect(retrieved!.iteration).toBe(1)
      
      const large = repo.getLarge(testRow.projectId, testRow.loopName)
      expect(large).toBeTruthy()
      expect(large!.lastAuditResult).toBeNull()
    })

    test('should error on second insert (conflict)', () => {
      repo.insert(testRow, testLarge)
      
      const updated: LoopRow = {
        ...testRow,
        iteration: 5,
        errorCount: 3,
      }
      expect(() => {
        repo.insert(updated, { lastAuditResult: null })
      }).toThrow() // Insert throws due to conflict
      
      // Original row is unchanged
      const retrieved = repo.get(testRow.projectId, testRow.loopName)
      expect(retrieved!.iteration).toBe(1) // Still original value
      expect(retrieved!.errorCount).toBe(0)
    })

    test('should round-trip a row with phase=post_action', () => {
      const row: LoopRow = {
        ...testRow,
        loopName: 'post-action-loop',
        currentSessionId: 'session-post-action',
        phase: 'post_action',
      }
      repo.insert(row, testLarge)

      const retrieved = repo.get(row.projectId, row.loopName)
      expect(retrieved).toBeTruthy()
      expect(retrieved!.phase).toBe('post_action')
      expect(retrieved!.loopName).toBe('post-action-loop')
    })
  })

  describe('insert atomicity', () => {
    beforeEach(() => {
      db.run(`DROP TABLE loop_large_fields`)
      db.run(`
        CREATE TABLE loop_large_fields (
          project_id          TEXT NOT NULL,
          loop_name           TEXT NOT NULL,
          last_audit_result   TEXT,
          post_action_report  TEXT,
          goal                TEXT CHECK(goal != '__TXN_FAIL_SENTINEL__'),
          PRIMARY KEY (project_id, loop_name),
          FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
        )
      `)
      repo = createLoopsRepo(db)
    })

    test('rolls back the loops row when the large-field write fails (goal loop)', () => {
      const row: LoopRow = {
        ...testRow,
        loopName: 'goal-txn-fail',
        currentSessionId: 'goal-txn-session',
        kind: 'goal',
      }
      const large: LoopLargeFields = {
        lastAuditResult: null,
        goal: '__TXN_FAIL_SENTINEL__',
      }

      expect(() => repo.insert(row, large)).toThrow()

      expect(repo.get(row.projectId, row.loopName)).toBeNull()
      expect(repo.getLarge(row.projectId, row.loopName)).toBeNull()
    })

    test('commit succeeds atomically when both writes are valid (goal loop)', () => {
      const row: LoopRow = {
        ...testRow,
        loopName: 'goal-txn-ok',
        currentSessionId: 'goal-txn-ok-session',
        kind: 'goal',
      }
      const large: LoopLargeFields = {
        lastAuditResult: null,
        goal: 'Add a /health endpoint with tests.',
      }

      expect(repo.insert(row, large)).toBe(true)
      const retrieved = repo.get(row.projectId, row.loopName)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.kind).toBe('goal')
      const largeRetrieved = repo.getLarge(row.projectId, row.loopName)
      expect(largeRetrieved).not.toBeNull()
      expect(largeRetrieved!.goal).toBe('Add a /health endpoint with tests.')
    })
  })

  describe('getBySessionId', () => {
    test('should find loop by session ID', () => {
      repo.insert(testRow, testLarge)
      
      const found = repo.getBySessionId(testRow.projectId, testRow.currentSessionId)
      expect(found).toBeTruthy()
      expect(found!.loopName).toBe(testRow.loopName)
    })

    test('should return null for non-existent session', () => {
      const found = repo.getBySessionId(testRow.projectId, 'non-existent')
      expect(found).toBeNull()
    })

    test('should resolve a reused session ID to the running loop', () => {
      repo.insert(testRow, testLarge)
      repo.terminate(testRow.projectId, testRow.loopName, {
        status: 'completed',
        reason: 'done',
        completedAt: Date.now(),
      })
      const running: LoopRow = {
        ...testRow,
        loopName: 'running-loop',
      }
      repo.insert(running, testLarge)

      expect(repo.getBySessionId(testRow.projectId, testRow.currentSessionId)?.loopName).toBe('running-loop')
    })

    test('should enforce unique session ID constraint', () => {
      repo.insert(testRow, testLarge)
      
      const duplicate: LoopRow = {
        ...testRow,
        loopName: 'another-loop',
        currentSessionId: testRow.currentSessionId,
      }
      
      expect(() => {
        repo.insert(duplicate, testLarge)
      }).toThrow(/UNIQUE constraint failed/)
    })
  })

  describe('listByStatus', () => {
    test('should filter by status', () => {
      const running1: LoopRow = { ...testRow, loopName: 'running-1', status: 'running', currentSessionId: 'session-running-1' }
      const running2: LoopRow = { ...testRow, loopName: 'running-2', status: 'running', currentSessionId: 'session-running-2' }
      const completed: LoopRow = { ...testRow, loopName: 'completed-1', status: 'completed', completedAt: Date.now(), currentSessionId: 'session-completed-1' }
      
      repo.insert(running1, testLarge)
      repo.insert(running2, testLarge)
      repo.insert(completed, testLarge)
      
      const running = repo.listByStatus(testRow.projectId, ['running'])
      expect(running).toHaveLength(2)
      expect(running.map(r => r.loopName)).toContain('running-1')
      expect(running.map(r => r.loopName)).toContain('running-2')
      
      const completedList = repo.listByStatus(testRow.projectId, ['completed'])
      expect(completedList).toHaveLength(1)
      expect(completedList[0].loopName).toBe('completed-1')
    })

    test('should return empty array for no matches', () => {
      const running = repo.listByStatus(testRow.projectId, ['running'])
      expect(running).toHaveLength(0)
    })
  })

  describe('atomic increment methods', () => {
    test('incrementError should atomically increment error count', async () => {
      repo.insert(testRow, testLarge)
      
      // Simulate concurrent increments
      const increments = Array.from({ length: 10 }, () =>
        repo.incrementError(testRow.projectId, testRow.loopName)
      )
      
      const results = await Promise.all(increments.map(async (fn) => fn))
      
      // All increments should succeed sequentially
      const final = repo.get(testRow.projectId, testRow.loopName)
      expect(final!.errorCount).toBe(10)
    })

    test('resetError should reset error count and model_failed', () => {
      const errorRow: LoopRow = { ...testRow, errorCount: 5, modelFailed: true }
      repo.insert(errorRow, testLarge)
      
      repo.resetError(testRow.projectId, testRow.loopName)
      
      const final = repo.get(testRow.projectId, testRow.loopName)
      expect(final!.errorCount).toBe(0)
      expect(final!.modelFailed).toBe(false)
    })
  })

  describe('transition: insert → updatePhase → terminate', () => {
    test('should support full lifecycle transitions', () => {
      // Insert running loop
      repo.insert(testRow, testLarge)
      
      // Update phase
      repo.updatePhase(testRow.projectId, testRow.loopName, 'auditing')
      let retrieved = repo.get(testRow.projectId, testRow.loopName)
      expect(retrieved!.phase).toBe('auditing')
      
      // Update iteration
      repo.updateIteration(testRow.projectId, testRow.loopName, 5)
      retrieved = repo.get(testRow.projectId, testRow.loopName)
      expect(retrieved!.iteration).toBe(5)
      
      // Terminate
      const now = Date.now()
      repo.terminate(testRow.projectId, testRow.loopName, {
        status: 'completed',
        reason: 'completed',
        completedAt: now,
        summary: 'Done!',
      })
      
      retrieved = repo.get(testRow.projectId, testRow.loopName)
      expect(retrieved!.status).toBe('completed')
      expect(retrieved!.completedAt).toBe(now)
      expect(retrieved!.terminationReason).toBe('completed')
      expect(retrieved!.completionSummary).toBe('Done!')
    })
  })

  describe('findPartial', () => {
    beforeEach(() => {
      const loops: LoopRow[] = [
        { ...testRow, loopName: 'feature-auth', worktreeBranch: 'feature/auth', currentSessionId: 'session-1' },
        { ...testRow, loopName: 'feature-login', worktreeBranch: 'feature/login', currentSessionId: 'session-2' },
        { ...testRow, loopName: 'bugfix-header', worktreeBranch: 'bugfix/header', currentSessionId: 'session-3' },
        { ...testRow, loopName: 'test-utils', worktreeBranch: null, currentSessionId: 'session-4' },
      ]
      loops.forEach((loop) => repo.insert(loop, testLarge))
    })

    test('should find exact match', () => {
      const result = repo.findPartial(testRow.projectId, 'feature-auth')
      expect(result.match).toBeTruthy()
      expect(result.match!.loopName).toBe('feature-auth')
      expect(result.candidates).toHaveLength(0)
    })

    test('should find substring match', () => {
      const result = repo.findPartial(testRow.projectId, 'feature')
      expect(result.match).toBeNull()
      expect(result.candidates).toHaveLength(2)
      expect(result.candidates.map(c => c.loopName)).toContain('feature-auth')
      expect(result.candidates.map(c => c.loopName)).toContain('feature-login')
    })

    test('should return empty for no match', () => {
      const result = repo.findPartial(testRow.projectId, 'nonexistent')
      expect(result.match).toBeNull()
      expect(result.candidates).toHaveLength(0)
    })

    test('should handle ambiguous partial match', () => {
      const result = repo.findPartial(testRow.projectId, 'feat')
      expect(result.match).toBeNull()
      expect(result.candidates).toHaveLength(2)
    })
  })

  describe('delete', () => {
    test('should delete loop and large fields', () => {
      repo.insert(testRow, testLarge)
      
      repo.delete(testRow.projectId, testRow.loopName)
      
      expect(repo.get(testRow.projectId, testRow.loopName)).toBeNull()
      expect(repo.getLarge(testRow.projectId, testRow.loopName)).toBeNull()
    })

    test('delete non-existent should not throw', () => {
      expect(() => {
        repo.delete(testRow.projectId, 'nonexistent')
      }).not.toThrow()
    })
  })

  describe('setCurrentSessionId', () => {
    test('should update session ID', () => {
      repo.insert(testRow, testLarge)
      
      repo.setCurrentSessionId(testRow.projectId, testRow.loopName, 'new-session')
      
      const retrieved = repo.get(testRow.projectId, testRow.loopName)
      expect(retrieved!.currentSessionId).toBe('new-session')
      
      const bySession = repo.getBySessionId(testRow.projectId, 'new-session')
      expect(bySession!.loopName).toBe(testRow.loopName)
    })
  })

  describe('setModelFailed', () => {
    test('should set model_failed flag', () => {
      repo.insert(testRow, testLarge)
      
      repo.setModelFailed(testRow.projectId, testRow.loopName, true)
      
      const retrieved = repo.get(testRow.projectId, testRow.loopName)
      expect(retrieved!.modelFailed).toBe(true)
    })
  })

  describe('setLastAuditResult', () => {
    test('should set last audit result', () => {
      repo.insert(testRow, testLarge)
      
      repo.setLastAuditResult(testRow.projectId, testRow.loopName, 'Audit findings...')
      
      const large = repo.getLarge(testRow.projectId, testRow.loopName)
      expect(large!.lastAuditResult).toBe('Audit findings...')
    })
  })

  describe('setPostActionReport', () => {
    test('should set post action report and round-trip via getLarge', () => {
      repo.insert(testRow, testLarge)

      repo.setPostActionReport(testRow.projectId, testRow.loopName, 'PR review transcript...')

      const large = repo.getLarge(testRow.projectId, testRow.loopName)
      expect(large!.postActionReport).toBe('PR review transcript...')
    })

    test('should clear post action report on restart', () => {
      repo.insert(testRow, testLarge)
      repo.setPostActionReport(testRow.projectId, testRow.loopName, 'stale report')

      repo.restart(testRow.projectId, testRow.loopName, {
        sessionId: 'restart-session',
        phase: 'coding',
        iteration: 0,
        auditCount: 0,
        sandbox: false,
        sandboxContainer: null,
        workspaceId: null,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: false,
        startedAt: Date.now(),
        executorSessionId: null,
      })

      const large = repo.getLarge(testRow.projectId, testRow.loopName)
      expect(large!.postActionReport).toBeNull()
    })
  })

  describe('hostSessionId', () => {
    test('should persist and round-trip hostSessionId', () => {
      const rowWithHost: LoopRow = {
        ...testRow,
        loopName: 'loop-with-host',
        currentSessionId: 'session-host',
        hostSessionId: 'host-session-123',
      }
      
      repo.insert(rowWithHost, testLarge)
      
      const retrieved = repo.get(rowWithHost.projectId, rowWithHost.loopName)
      expect(retrieved).toBeTruthy()
      expect(retrieved!.hostSessionId).toBe('host-session-123')
    })

    test('should store null when hostSessionId is not provided', () => {
      const rowWithoutHost: LoopRow = {
        ...testRow,
        loopName: 'loop-without-host',
        currentSessionId: 'session-no-host',
        hostSessionId: null,
      }

      repo.insert(rowWithoutHost, testLarge)

      const retrieved = repo.get(rowWithoutHost.projectId, rowWithoutHost.loopName)
      expect(retrieved).toBeTruthy()
      expect(retrieved!.hostSessionId).toBeNull()
    })
  })

  describe('replaceSession', () => {
    test('should atomically update current_session_id, phase, and iteration', () => {
      const row: LoopRow = {
        ...testRow,
        loopName: 'loop-replace-test',
        currentSessionId: 'L1',
        phase: 'coding',
        iteration: 1,
        errorCount: 3,
        modelFailed: true,
      }
      
      repo.insert(row, testLarge)
      
      repo.replaceSession(row.projectId, row.loopName, {
        sessionId: 'L2',
        phase: 'auditing',
        iteration: 2,
        resetError: true,
      })
      
      const retrieved = repo.get(row.projectId, row.loopName)
      expect(retrieved!.currentSessionId).toBe('L2')
      expect(retrieved!.phase).toBe('auditing')
      expect(retrieved!.iteration).toBe(2)
      expect(retrieved!.errorCount).toBe(0)
      expect(retrieved!.modelFailed).toBe(false)
    })
  })

  describe('decomposition setters removed', () => {
    test('LoopsRepo no longer exposes decomposition setters', () => {
      const repoAsAny = repo as unknown as Record<string, unknown>
      expect(repoAsAny.setDecompositionStatus).toBeUndefined()
      expect(repoAsAny.setDecompositionMode).toBeUndefined()
      expect(repoAsAny.setDecompositionSessionId).toBeUndefined()
    })
  })

  describe('restore preserves post_action_report across restart rollback', () => {
    test('restore re-populates post_action_report after restart cleared it', () => {
      // Insert a post_action-phase loop that carries a persisted post-action
      // report. The `restart` flow clears the report before persisting the
      // new phase, so a subsequent prompt-failure rollback MUST restore it via
      // `restore` (which writes loop_large_fields via upsertLargeStmt).
      repo.insert({ ...testRow, loopName: 'post-action-loop', phase: 'post_action' }, testLarge)
      repo.setPostActionReport(testRow.projectId, 'post-action-loop', 'post-action report body')
      expect(repo.getLarge(testRow.projectId, 'post-action-loop')!.postActionReport).toBe('post-action report body')

      // Restart clears the report.
      repo.restart(testRow.projectId, 'post-action-loop', {
        sessionId: 'new-session',
        phase: 'post_action',
        iteration: 1,
        auditCount: 0,
        sandbox: false,
        sandboxContainer: null,
        workspaceId: null,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: false,
        startedAt: Date.now(),
        executorSessionId: null,
      })
      expect(repo.getLarge(testRow.projectId, 'post-action-loop')!.postActionReport).toBeNull()

      // Rollback: restore the previous loop row + the post-action report.
      const restoredRow: LoopRow = {
        ...testRow,
        loopName: 'post-action-loop',
        phase: 'post_action',
        status: 'errored',
        currentSessionId: 'session-old',
        terminationReason: 'restart_prompt_failed',
        completedAt: Date.now(),
      }
      repo.restore(restoredRow, {
        lastAuditResult: null,
        postActionReport: 'post-action report body',
        goal: null,
      })

      const large = repo.getLarge(testRow.projectId, 'post-action-loop')!
      // The previously-cleared post-action report is restored through the
      // shared upsertLargeStmt path.
      expect(large.postActionReport).toBe('post-action report body')
    })
  })
})
