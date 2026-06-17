import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import { createReviewTools } from '../../src/tools/review'
import { createSessionLoopResolver } from '../../src/services/session-loop-resolver'
import type { Logger } from '../../src/types'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('review section scoping', () => {
  let db: Database
  let dbPath: string
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let loopService: ReturnType<typeof createLoopService>
  let tools: ReturnType<typeof createReviewTools>
  let parentSessions: Record<string, string>
  const projectId = 'test-project'

  beforeEach(() => {
    parentSessions = {}
    tempDir = mkdtempSync(join(tmpdir(), 'review-section-scope-test-'))
    dbPath = join(tempDir, 'test.db')
    db = new Database(dbPath)

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
        total_sections       INTEGER NOT NULL DEFAULT 0,
        final_audit_done     INTEGER NOT NULL DEFAULT 0,
        final_audit_attempts INTEGER NOT NULL DEFAULT 0,
        execution_variant    TEXT,
        auditor_variant      TEXT,
        PRIMARY KEY (project_id, loop_name)
      )
    `)

    db.run(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
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
        project_id   TEXT NOT NULL,
        loop_name    TEXT NOT NULL DEFAULT '',
        file         TEXT NOT NULL,
        line         INTEGER NOT NULL,
        severity     TEXT NOT NULL,
        description  TEXT NOT NULL,
        scenario     TEXT,
        created_at   INTEGER NOT NULL,
        section_index INTEGER,
        PRIMARY KEY (project_id, loop_name, file, line, section_index)
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_review_findings_loop_name ON review_findings(project_id, loop_name)`)

    db.run(`
      CREATE TABLE section_plans (
        project_id    TEXT    NOT NULL,
        loop_name     TEXT    NOT NULL,
        section_index INTEGER NOT NULL,
        title         TEXT    NOT NULL,
        content       TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        started_at    INTEGER,
        completed_at  INTEGER,
        created_at    INTEGER NOT NULL,
        summary_done           TEXT,
        summary_deviations     TEXT,
        summary_follow_ups     TEXT,
        PRIMARY KEY (project_id, loop_name, section_index),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger, undefined, undefined, sectionPlansRepo)
    const sessionLoopResolver = createSessionLoopResolver({
      loop: loopService,
      getParentSessionId: async (sessionId: string) => parentSessions[sessionId] ?? null,
      getSessionDirectory: async () => tempDir,
      logger: mockLogger,
    })
    const ctx = {
      reviewFindingsRepo,
      plansRepo,
      loopsRepo,
      projectId,
      logger: mockLogger,
      loop: loopService,
      directory: tempDir,
      resolveActiveLoopForSession: sessionLoopResolver.resolveActiveLoopForSession,
    } as any
    tools = createReviewTools(ctx)
  })

  afterEach(() => {
    db.close()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function insertLoop(loopName: string, opts?: { currentSectionIndex?: number; totalSections?: number; sessionId?: string; phase?: 'coding' | 'auditing' | 'final_auditing' }) {
    loopsRepo.insert({
      projectId,
      loopName,
      status: 'running',
      currentSessionId: opts?.sessionId ?? `${loopName}-session`,
      worktree: false,
      worktreeDir: tempDir,
      worktreeBranch: null,
      projectDir: tempDir,
      maxIterations: 10,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: opts?.phase ?? 'coding',
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
      currentSectionIndex: opts?.currentSectionIndex ?? 0,
      totalSections: opts?.totalSections ?? 0,
      finalAuditDone: 0,
      executionVariant: null,
      auditorVariant: null,
    }, { lastAuditResult: null })
  }

  function makeToolContext(sessionID: string) {
    return { sessionID, directory: tempDir } as any
  }

  describe('review-read: section-scoped reading', () => {
    beforeEach(() => {
      insertLoop('scoped-loop', { currentSectionIndex: 0, totalSections: 2 })
    })

    test('scoped to current section by default', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Section 0 bug',
        loopName: 'scoped-loop',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'src/b.ts',
        line: 20,
        severity: 'warning',
        description: 'Section 1 warning',
        loopName: 'scoped-loop',
        sectionIndex: 1,
      })

      const result = await tools['review-read'].execute({}, makeToolContext('scoped-loop-session'))
      expect(result).toContain('Section 0 bug')
      expect(result).not.toContain('Section 1 warning')
    })

    test('crossSection=true returns null-section findings', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Cross-section bug',
        loopName: 'scoped-loop',
        sectionIndex: null,
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'src/b.ts',
        line: 20,
        severity: 'warning',
        description: 'Section 0 warning',
        loopName: 'scoped-loop',
        sectionIndex: 0,
      })

      const result = await tools['review-read'].execute({ crossSection: true }, makeToolContext('scoped-loop-session'))
      expect(result).toContain('Cross-section bug')
      expect(result).not.toContain('Section 0 warning')
    })

    test('allSections=true returns all findings', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Section 0 bug',
        loopName: 'scoped-loop',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'src/b.ts',
        line: 20,
        severity: 'warning',
        description: 'Section 1 warning',
        loopName: 'scoped-loop',
        sectionIndex: 1,
      })

      const result = await tools['review-read'].execute({ allSections: true }, makeToolContext('scoped-loop-session'))
      expect(result).toContain('Section 0 bug')
      expect(result).toContain('Section 1 warning')
    })

    test('explicit empty loopName falls back to session scope, not the non-loop bucket', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Loop section 0 bug',
        loopName: 'scoped-loop',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'src/orphan.ts',
        line: 99,
        severity: 'warning',
        description: 'Orphaned non-loop finding',
        loopName: null,
      })

      const result = await tools['review-read'].execute({ loopName: '   ' }, makeToolContext('scoped-loop-session'))
      expect(result).toContain('Loop section 0 bug')
      expect(result).not.toContain('Orphaned non-loop finding')
    })

    test('handles different current section index', async () => {
      insertLoop('scoped-loop-2', { currentSectionIndex: 1, totalSections: 2, sessionId: 'scoped-loop-2-session' })

      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Section 0 bug',
        loopName: 'scoped-loop-2',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'src/b.ts',
        line: 20,
        severity: 'warning',
        description: 'Section 1 warning',
        loopName: 'scoped-loop-2',
        sectionIndex: 1,
      })

      const result = await tools['review-read'].execute({}, makeToolContext('scoped-loop-2-session'))
      expect(result).not.toContain('Section 0 bug')
      expect(result).toContain('Section 1 warning')
    })

    test('explicit loopName returns all sections when read from outside the loop', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Section 0 bug',
        loopName: 'scoped-loop',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'src/b.ts',
        line: 20,
        severity: 'warning',
        description: 'Section 1 warning',
        loopName: 'scoped-loop',
        sectionIndex: 1,
      })

      const result = await tools['review-read'].execute({ loopName: 'scoped-loop' }, makeToolContext('outside-session'))
      expect(result).toContain('Section 0 bug')
      expect(result).toContain('Section 1 warning')
    })
  })

  describe('review-write: auto-injects section index', () => {
    beforeEach(() => {
      insertLoop('write-loop', { currentSectionIndex: 0, totalSections: 2 })
    })

    test('auto-injects section index from current section', async () => {
      const result = await tools['review-write'].execute(
        {
          file: 'src/a.ts',
          line: 10,
          severity: 'bug',
          description: 'Auto-injected section bug',
        },
        makeToolContext('write-loop-session')
      )

      expect(result).toContain('Stored review finding')
      expect(result).toContain('for section 0')

      const findings = reviewFindingsRepo.listByLoopName(projectId, 'write-loop')
      expect(findings).toHaveLength(1)
      expect(findings[0].sectionIndex).toBe(0)
      expect(findings[0].loopName).toBe('write-loop')
    })

    test('crossSection=true writes null section index', async () => {
      const result = await tools['review-write'].execute(
        {
          file: 'src/a.ts',
          line: 10,
          severity: 'bug',
          description: 'Cross-section finding',
          crossSection: true,
        },
        makeToolContext('write-loop-session')
      )

      expect(result).toContain('Stored review finding')

      const findings = reviewFindingsRepo.listByLoopName(projectId, 'write-loop')
      expect(findings).toHaveLength(1)
      expect(findings[0].sectionIndex).toBeNull()
    })

    test('explicit sectionIndex override', async () => {
      const result = await tools['review-write'].execute(
        {
          file: 'src/a.ts',
          line: 10,
          severity: 'bug',
          description: 'Explicit section bug',
          sectionIndex: 1,
        },
        makeToolContext('write-loop-session')
      )

      expect(result).toContain('Stored review finding')
      expect(result).toContain('for section 1')

      const findings = reviewFindingsRepo.listByLoopName(projectId, 'write-loop')
      expect(findings).toHaveLength(1)
      expect(findings[0].sectionIndex).toBe(1)
    })
  })

  describe('review-delete: scoped to current section', () => {
    beforeEach(() => {
      insertLoop('delete-loop', { currentSectionIndex: 0, totalSections: 2 })
    })

    test('scoped to current section', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Section 0 bug',
        loopName: 'delete-loop',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'warning',
        description: 'Section 1 warning',
        loopName: 'delete-loop',
        sectionIndex: 1,
      })

      const result = await tools['review-delete'].execute(
        { file: 'src/a.ts', line: 10 },
        makeToolContext('delete-loop-session')
      )

      expect(result).toContain('Deleted review finding')

      const remaining = reviewFindingsRepo.listByLoopName(projectId, 'delete-loop')
      expect(remaining).toHaveLength(1)
      expect(remaining[0].sectionIndex).toBe(1)
      expect(remaining[0].description).toBe('Section 1 warning')
    })

    test('explicit sectionIndex override', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Section 0 bug',
        loopName: 'delete-loop',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'warning',
        description: 'Section 1 warning',
        loopName: 'delete-loop',
        sectionIndex: 1,
      })

      const result = await tools['review-delete'].execute(
        { file: 'src/a.ts', line: 10, sectionIndex: 1 },
        makeToolContext('delete-loop-session')
      )

      expect(result).toContain('Deleted review finding')

      const remaining = reviewFindingsRepo.listByLoopName(projectId, 'delete-loop')
      expect(remaining).toHaveLength(1)
      expect(remaining[0].sectionIndex).toBe(0)
      expect(remaining[0].description).toBe('Section 0 bug')
    })
  })

  describe('review-delete during final audit mirrors review-read (all sections)', () => {
    beforeEach(() => {
      insertLoop('final-loop', { currentSectionIndex: 4, totalSections: 5, phase: 'final_auditing' })
    })

    test('deletes a finding from an earlier section the auditor can see', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Earlier section bug',
        loopName: 'final-loop',
        sectionIndex: 0,
      })

      const result = await tools['review-delete'].execute(
        { file: 'src/a.ts', line: 10 },
        makeToolContext('final-loop-session')
      )

      expect(result).toContain('Deleted review finding')
      expect(reviewFindingsRepo.listByLoopName(projectId, 'final-loop')).toHaveLength(0)
    })

    test('deletes a cross-section finding without crossSection flag', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/b.ts',
        line: 20,
        severity: 'bug',
        description: 'Cross-section bug',
        loopName: 'final-loop',
        sectionIndex: null,
      })

      const result = await tools['review-delete'].execute(
        { file: 'src/b.ts', line: 20 },
        makeToolContext('final-loop-session')
      )

      expect(result).toContain('Deleted review finding')
      expect(reviewFindingsRepo.listByLoopName(projectId, 'final-loop')).toHaveLength(0)
    })
  })

  describe('different sections can report findings on same file:line', () => {
    test('two different sections can have findings on the same file:line', () => {
      const r1 = reviewFindingsRepo.write({
        projectId,
        file: 'src/shared.ts',
        line: 5,
        severity: 'bug',
        description: 'Section 0 finding on shared file',
        loopName: 'multi-section-loop',
        sectionIndex: 0,
      })

      const r2 = reviewFindingsRepo.write({
        projectId,
        file: 'src/shared.ts',
        line: 5,
        severity: 'warning',
        description: 'Section 1 finding on shared file',
        loopName: 'multi-section-loop',
        sectionIndex: 1,
      })

      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)

      const findings = reviewFindingsRepo.listByLoopName(projectId, 'multi-section-loop')
      expect(findings).toHaveLength(2)
      expect(findings.map(f => f.sectionIndex)).toEqual([0, 1])
    })
  })

  describe('same section same file:line produces conflict', () => {
    test('duplicate finding in same section is rejected', () => {
      const r1 = reviewFindingsRepo.write({
        projectId,
        file: 'src/dup.ts',
        line: 15,
        severity: 'bug',
        description: 'First finding',
        loopName: 'dup-loop',
        sectionIndex: 0,
      })

      const r2 = reviewFindingsRepo.write({
        projectId,
        file: 'src/dup.ts',
        line: 15,
        severity: 'warning',
        description: 'Duplicate finding',
        loopName: 'dup-loop',
        sectionIndex: 0,
      })

      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(false)
      expect(r2.conflict).toBe(true)

      const findings = reviewFindingsRepo.listByLoopName(projectId, 'dup-loop')
      expect(findings).toHaveLength(1)
      expect(findings[0].description).toBe('First finding')
    })
  })

  describe('section-scoped reading with file filter', () => {
    beforeEach(() => {
      insertLoop('filter-loop', { currentSectionIndex: 0, totalSections: 2 })
    })

    test('file filter works within section scope', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Section 0 A',
        loopName: 'filter-loop',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'src/b.ts',
        line: 20,
        severity: 'warning',
        description: 'Section 0 B',
        loopName: 'filter-loop',
        sectionIndex: 0,
      })

      const result = await tools['review-read'].execute({ file: 'src/a.ts' }, makeToolContext('filter-loop-session'))
      expect(result).toContain('Section 0 A')
      expect(result).not.toContain('Section 0 B')
    })
  })

  describe('scope resolves via parent-session hop when caller is a subagent', () => {
    beforeEach(() => {
      // Loop owned by 'coder-session'. The audit subagent is a child session
      // whose parent is the loop's registered session.
      insertLoop('audit-loop', { currentSectionIndex: 0, totalSections: 2, sessionId: 'coder-session' })
      parentSessions['audit-subagent-session'] = 'coder-session'
    })

    test('review-read from a subagent session still sees the loop section findings', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Loop section 0 bug',
        loopName: 'audit-loop',
        sectionIndex: 0,
      })

      // Child session not registered to any loop; resolves via its parent.
      const result = await tools['review-read'].execute({}, makeToolContext('audit-subagent-session'))
      expect(result).toContain('Loop section 0 bug')
    })

    test('review-write from a subagent session scopes the finding to the loop', async () => {
      const result = await tools['review-write'].execute(
        {
          file: 'src/a.ts',
          line: 10,
          severity: 'bug',
          description: 'Subagent-written bug',
        },
        makeToolContext('audit-subagent-session'),
      )
      expect(result).toContain('Stored review finding')

      const findings = reviewFindingsRepo.listByLoopName(projectId, 'audit-loop')
      expect(findings).toHaveLength(1)
      expect(findings[0].loopName).toBe('audit-loop')
      expect(findings[0].sectionIndex).toBe(0)
    })

    test('review-delete from a subagent session clears the loop section finding', async () => {
      reviewFindingsRepo.write({
        projectId,
        file: 'src/a.ts',
        line: 10,
        severity: 'bug',
        description: 'Loop section 0 bug',
        loopName: 'audit-loop',
        sectionIndex: 0,
      })

      const result = await tools['review-delete'].execute(
        { file: 'src/a.ts', line: 10 },
        makeToolContext('audit-subagent-session'),
      )
      expect(result).toContain('Deleted review finding')
      expect(reviewFindingsRepo.listByLoopName(projectId, 'audit-loop')).toHaveLength(0)
    })
  })
})
