import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
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
  const projectId = 'test-project'

  beforeEach(() => {
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
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger, undefined, undefined, undefined, sectionPlansRepo)
    const ctx = {
      reviewFindingsRepo,
      plansRepo,
      loopsRepo,
      projectId,
      logger: mockLogger,
      loop: loopService,
      directory: tempDir,
    } as any
    tools = createReviewTools(ctx)
  })

  afterEach(() => {
    db.close()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function insertLoop(loopName: string, opts?: { currentSectionIndex?: number; totalSections?: number; sessionId?: string }) {
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
      phase: 'coding',
      executionModel: null,
      auditorModel: null,
      modelFailed: false,
      sandbox: false,
      sandboxContainer: null,
      startedAt: Date.now(),
      completedAt: null,
      terminationReason: null,
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
})
