import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readPlan, writePlan, deletePlan } from '../src/utils/tui-plan-store'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'

function createTestDb(dbPath: string): Database {
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE IF NOT EXISTS loops (
      project_id           TEXT NOT NULL,
      loop_name            TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','errored','stalled')),
      current_session_id   TEXT NOT NULL,
      worktree             INTEGER NOT NULL,
      worktree_dir         TEXT NOT NULL,
      worktree_branch      TEXT,
      project_dir          TEXT NOT NULL,
      max_iterations       INTEGER NOT NULL,
      iteration            INTEGER NOT NULL DEFAULT 0,
      audit_count          INTEGER NOT NULL DEFAULT 0,
      error_count          INTEGER NOT NULL DEFAULT 0,
      phase                TEXT NOT NULL CHECK(phase IN ('coding','auditing')),
      audit                INTEGER NOT NULL DEFAULT 0,
      completion_signal    TEXT,
      execution_model      TEXT,
      auditor_model        TEXT,
      model_failed         INTEGER NOT NULL DEFAULT 0,
      sandbox              INTEGER NOT NULL DEFAULT 0,
      sandbox_container    TEXT,
      started_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      termination_reason   TEXT,
      completion_summary   TEXT,
      workspace_id   TEXT,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  db.run(`CREATE UNIQUE INDEX idx_loops_session ON loops(project_id, current_session_id)`)
  db.run(`
    CREATE TABLE IF NOT EXISTS loop_large_fields (
      project_id          TEXT NOT NULL,
      loop_name           TEXT NOT NULL,
      prompt              TEXT,
      last_audit_result   TEXT,
      PRIMARY KEY (project_id, loop_name)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS plans (
      project_id   TEXT NOT NULL,
      loop_name    TEXT,
      session_id   TEXT,
      content      TEXT NOT NULL,
      updated_at   INTEGER NOT NULL,
      CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
      CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
      UNIQUE (project_id, loop_name),
      UNIQUE (project_id, session_id)
    )
  `)
  return db
}

describe('TUI Plan Store', () => {
  let tempDir: string
  let dbPath: string
  let db: Database
  const projectId = 'test-project'
  const sessionId = 'test-session-123'
  const planContent = '# Test Plan\n\nThis is a test plan.'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tui-plan-test-'))
    dbPath = join(tempDir, 'graph.db')
    db = createTestDb(dbPath)
  })

  afterEach(() => {
    try { db.close() } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
  })

  describe('readPlan', () => {
    test('Returns null when no plan exists', () => {
      const result = readPlan(projectId, sessionId, dbPath)
      expect(result).toBeNull()
    })

    test('Reads plan from session-based row when no loop mapping', () => {
      const plansRepo = createPlansRepo(db)
      plansRepo.writeForSession(projectId, sessionId, planContent)
      
      const result = readPlan(projectId, sessionId, dbPath)
      expect(result).toBe(planContent)
    })

    test('Reads plan from loop-bound row when session maps to a loop', () => {
      const loopsRepo = createLoopsRepo(db)
      const plansRepo = createPlansRepo(db)
      const loopName = 'test-loop'
      
      loopsRepo.insert({
        projectId,
        loopName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: true,
        worktreeDir: '/tmp/test-worktree',
        worktreeBranch: 'main',
        projectDir: '/tmp/test-project',
        maxIterations: 10,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        audit: true,
        completionSignal: null,
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
      }, { prompt: null, lastAuditResult: null })
      
      plansRepo.writeForLoop(projectId, loopName, planContent)
      
      const result = readPlan(projectId, sessionId, dbPath)
      expect(result).toBe(planContent)
    })
  })

  describe('writePlan', () => {
    test('Writes session-scoped plan when no loop mapping', () => {
      const success = writePlan(projectId, sessionId, planContent, dbPath)
      expect(success).toBe(true)
      
      const result = readPlan(projectId, sessionId, dbPath)
      expect(result).toBe(planContent)
    })
  })

  describe('deletePlan', () => {
    test('Deletes session-scoped plan', () => {
      writePlan(projectId, sessionId, planContent, dbPath)
      const deleted = deletePlan(projectId, sessionId, dbPath)
      expect(deleted).toBe(true)
      
      const result = readPlan(projectId, sessionId, dbPath)
      expect(result).toBeNull()
    })
  })
})
