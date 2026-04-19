import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopService } from '../src/services/loop'
import type { Logger } from '../src/types'

describe('LoopService', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  const projectId = 'test-project'

  const mockLogger: Logger = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-service-test-'))
    const dbPath = join(tempDir, 'loop-service-test.db')
    db = new Database(dbPath)

    // Create tables
    db.run(`
      CREATE TABLE loops (
        project_id           TEXT NOT NULL,
        loop_name            TEXT NOT NULL,
        status               TEXT NOT NULL,
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
        phase                TEXT NOT NULL,
        audit                INTEGER NOT NULL,
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
        PRIMARY KEY (project_id, loop_name)
      )
    `)

    db.run(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
        prompt              TEXT,
        last_audit_result   TEXT,
        PRIMARY KEY (project_id, loop_name),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    db.run(`
      CREATE TABLE plans (
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

    db.run(`
      CREATE TABLE review_findings (
        project_id TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT,
        branch TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, file, line)
      )
    `)

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)

    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  describe('hasOutstandingFindings', () => {
    test('returns true when only warning findings exist (no severity filter)', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        branch: 'b1',
      })

      expect(loopService.hasOutstandingFindings('b1')).toBe(true)
    })

    test('returns false when only warning findings exist and severity=bug filter is applied', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        branch: 'b1',
      })

      expect(loopService.hasOutstandingFindings('b1', 'bug')).toBe(false)
      expect(loopService.hasOutstandingFindings('b1', 'warning')).toBe(true)
    })

    test('returns true when bug findings exist with severity=bug filter', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
        scenario: 'test',
        branch: 'b2',
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 2,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        branch: 'b2',
      })

      expect(loopService.hasOutstandingFindings('b2', 'bug')).toBe(true)
      const bugFindings = loopService.getOutstandingFindings('b2', 'bug')
      expect(bugFindings.length).toBe(1)
      expect(bugFindings[0].severity).toBe('bug')
    })
  })

  describe('getOutstandingFindings', () => {
    test('returns all findings when no severity filter is provided', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
        scenario: 'test',
        branch: 'b2',
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 2,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        branch: 'b2',
      })

      const allFindings = loopService.getOutstandingFindings('b2')
      expect(allFindings.length).toBe(2)

      const warningFindings = loopService.getOutstandingFindings('b2', 'warning')
      expect(warningFindings.length).toBe(1)
      expect(warningFindings[0].severity).toBe('warning')
    })
  })

  describe('buildAuditPrompt', () => {
    test('contains plan completeness check instructions', () => {
      const state = {
        active: true,
        sessionId: 'test-session',
        loopName: 'test-loop',
        worktreeDir: '/tmp/test',
        worktreeBranch: 'test-branch',
        iteration: 1,
        maxIterations: 10,
        startedAt: new Date().toISOString(),
        phase: 'coding' as const,
        audit: true,
        errorCount: 0,
        auditCount: 0,
      }

      const prompt = loopService.buildAuditPrompt(state as any)

      expect(prompt).toContain('Plan completeness check:')
      expect(prompt).toContain('severity: "bug"')
      expect(prompt).toContain('For every plan phase, verify it is fully implemented')
      expect(prompt).toContain('Outstanding `bug` findings block loop termination')
    })
  })

  describe('getMinAudits removal', () => {
    test('getMinAudits is not exposed on the service', () => {
      expect((loopService as any).getMinAudits).toBeUndefined()
    })
  })

  describe('buildContinuationPrompt regression', () => {
    test('includes outstanding findings in continuation prompt', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
        scenario: 'test',
        branch: 'test-branch',
      })

      const state = {
        active: true,
        sessionId: 'test-session',
        loopName: 'test-loop',
        worktreeDir: '/tmp/test',
        worktreeBranch: 'test-branch',
        iteration: 1,
        maxIterations: 10,
        startedAt: new Date().toISOString(),
        prompt: 'Initial prompt',
        phase: 'coding' as const,
        audit: true,
        errorCount: 0,
        auditCount: 0,
      }

      const prompt = loopService.buildContinuationPrompt(state as any)

      expect(prompt).toContain('Outstanding Review Findings')
      expect(prompt).toContain('test.ts:1')
    })
  })
})
