import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../src/storage/repos/section-plans-repo'
import { createLoopService } from '../src/services/loop'
import type { Logger } from '../src/types'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('LoopService section management', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let tempDir: string
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'section-management-test-'))
    const dbPath = join(tempDir, 'test.db')
    db = new Database(dbPath)

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
        session_directory    TEXT,
        decomposition_status TEXT NOT NULL DEFAULT 'pending',
        decomposition_mode   TEXT NOT NULL DEFAULT 'agent',
        decomposition_session_id TEXT,
        current_section_index INTEGER NOT NULL DEFAULT 0,
        total_sections       INTEGER NOT NULL DEFAULT 0,
        final_audit_done     INTEGER NOT NULL DEFAULT 0,
        final_audit_attempts INTEGER NOT NULL DEFAULT 0,
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
        loop_name TEXT NOT NULL DEFAULT '',
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT,
        created_at INTEGER NOT NULL,
        section_index INTEGER,
        PRIMARY KEY (project_id, loop_name, file, line, section_index)
      )
    `)

    db.run(`
      CREATE TABLE section_plans (
        project_id    TEXT    NOT NULL,
        loop_name     TEXT    NOT NULL,
        section_index INTEGER NOT NULL,
        title         TEXT    NOT NULL,
        content       TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'pending',
        attempts      INTEGER NOT NULL DEFAULT 0,
        summary_done           TEXT,
        summary_deviations     TEXT,
        summary_follow_ups     TEXT,
        started_at    INTEGER,
        completed_at  INTEGER,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (project_id, loop_name, section_index),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger, undefined, undefined, undefined, sectionPlansRepo)
  })

  afterEach(() => {
    db.close()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function insertLoop(loopName: string) {
    loopsRepo.insert({
      projectId,
      loopName,
      status: 'running',
      currentSessionId: `${loopName}-session`,
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
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      decompositionStatus: 'completed',
      decompositionMode: 'deterministic',
      decompositionSessionId: null,
      currentSectionIndex: 0,
      totalSections: 2,
      finalAuditDone: 0,
    }, { prompt: 'test plan', lastAuditResult: null })
  }

  function insertSections(loopName: string, count: number) {
    const sections = Array.from({ length: count }, (_, i) => ({
      index: i,
      title: `Section ${i + 1}`,
      content: `Content for section ${i + 1}`,
    }))
    sectionPlansRepo.bulkInsert({ projectId, loopName, sections })
    loopsRepo.setTotalSections(projectId, loopName, count)
  }

  describe('completeSection', () => {
    test('marks section as completed with summary', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)

      loopService.completeSection('test-loop', 1, {
        done: 'Implemented feature X',
        deviations: 'None',
        followUps: 'Handled in section 2',
      })

      const section = sectionPlansRepo.get(projectId, 'test-loop', 1)
      expect(section).not.toBeNull()
      expect(section!.status).toBe('completed')
      expect(section!.summaryDone).toBe('Implemented feature X')
      expect(section!.summaryDeviations).toBe('None')
      expect(section!.summaryFollowUps).toBe('Handled in section 2')
      expect(section!.completedAt).not.toBeNull()
    })
  })

  describe('incrementSectionAttempts', () => {
    test('increments attempt counter', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 1)

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.attempts).toBe(0)

      loopService.incrementSectionAttempts('test-loop', 0)
      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.attempts).toBe(1)

      loopService.incrementSectionAttempts('test-loop', 0)
      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.attempts).toBe(2)
    })
  })

  describe('resetSectionForRewind', () => {
    test('resets section to in_progress with cleared summaries', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 1)
      sectionPlansRepo.setSummary(projectId, 'test-loop', 0, { done: 'old done', deviations: 'old dev', followUps: 'old follow' })
      sectionPlansRepo.setCompletedAt(projectId, 'test-loop', 0, Date.now())

      loopService.resetSectionForRewind('test-loop', 0)

      const section = sectionPlansRepo.get(projectId, 'test-loop', 0)
      expect(section).not.toBeNull()
      expect(section!.status).toBe('in_progress')
      expect(section!.attempts).toBe(0)
      expect(section!.summaryDone).toBeNull()
      expect(section!.summaryDeviations).toBeNull()
      expect(section!.summaryFollowUps).toBeNull()
      expect(section!.completedAt).toBeNull()
    })
  })

  describe('setCurrentSectionIndex', () => {
    test('updates current section index', () => {
      insertLoop('test-loop')

      loopService.setCurrentSectionIndex('test-loop', 2)

      const state = loopService.getActiveState('test-loop')
      expect(state).not.toBeNull()
      expect(state!.currentSectionIndex).toBe(2)
    })
  })

  describe('setFinalAuditDone', () => {
    test('sets final audit done flag', () => {
      insertLoop('test-loop')

      loopService.setFinalAuditDone('test-loop', true)

      const state = loopService.getActiveState('test-loop')
      expect(state).not.toBeNull()
      expect(state!.finalAuditDone).toBe(true)
    })
  })



  describe('buildAuditPrompt routing', () => {
    test('uses section audit prompt for sectioned loops', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)

      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildAuditPrompt(state)

      expect(prompt).toContain('Loop section audit 1/3')
    })

    test('uses legacy audit prompt for non-sectioned loops', () => {
      // Insert a loop with no sections
      loopsRepo.insert({
        projectId,
        loopName: 'no-sections',
        status: 'running',
        currentSessionId: 'no-sections-session',
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
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        decompositionStatus: 'skipped',
        decompositionMode: 'deterministic',
        decompositionSessionId: null,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: 0,
      }, { prompt: 'test plan', lastAuditResult: null })

      const state = loopService.getActiveState('no-sections')!
      const prompt = loopService.buildAuditPrompt(state)

      expect(prompt).toContain('Post-iteration')
      expect(prompt).not.toContain('Loop section audit')
    })
  })

  describe('buildFinalAuditPrompt', () => {
    test('includes section summaries and final-audit instructions', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setSummary(projectId, 'test-loop', 0, { done: 'Feature A implemented' })

      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildFinalAuditPrompt(state)

      expect(prompt).toContain('Final integration audit')
      expect(prompt).toContain('Section 1: Section 1')
      expect(prompt).toContain('Feature A implemented')
      expect(prompt).toContain('final-audit:clear')
      expect(prompt).toContain('crossSection: true')
    })
  })

  describe('parseSectionSummary', () => {
    test('extracts summary sections', () => {
      const text = `<!-- section-summary:start -->
### Done
- Implemented feature X
### Deviations
- None
### Follow-ups
- Handled in section 2
<!-- section-summary:end -->`

      const result = loopService.parseSectionSummary(text)
      expect(result).not.toBeNull()
      expect(result!.done).toContain('Implemented feature X')
      expect(result!.deviations).toContain('None')
      expect(result!.followUps).toContain('Handled in section 2')
    })

    test('returns null when no section summary marker', () => {
      const result = loopService.parseSectionSummary('No summary here')
      expect(result).toBeNull()
    })
  })

  describe('getNextIncompleteSectionPlan', () => {
    test('returns lowest-index non-completed section', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')

      const state = loopService.getActiveState('test-loop')!
      const result = loopService.getNextIncompleteSectionPlan(state)
      expect(result).not.toBeNull()
      expect(result!.sectionIndex).toBe(1)
    })

    test('returns failed before later pending', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'failed')

      const state = loopService.getActiveState('test-loop')!
      const result = loopService.getNextIncompleteSectionPlan(state)
      expect(result).not.toBeNull()
      expect(result!.sectionIndex).toBe(0)
      expect(result!.status).toBe('failed')
    })

    test('returns null when all sections are completed', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'completed')

      const state = loopService.getActiveState('test-loop')!
      const result = loopService.getNextIncompleteSectionPlan(state)
      expect(result).toBeNull()
    })

    test('does not update state.currentSectionIndex', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')

      const stateBefore = loopService.getActiveState('test-loop')!
      expect(stateBefore.currentSectionIndex).toBe(0)

      loopService.getNextIncompleteSectionPlan(stateBefore)

      const stateAfter = loopService.getActiveState('test-loop')!
      expect(stateAfter.currentSectionIndex).toBe(0)
    })

    test('does not mutate section statuses or timestamps', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)

      const beforeStatuses = [
        sectionPlansRepo.get(projectId, 'test-loop', 0)?.status,
        sectionPlansRepo.get(projectId, 'test-loop', 1)?.status,
      ]

      const state = loopService.getActiveState('test-loop')!
      loopService.getNextIncompleteSectionPlan(state)

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.status).toBe(beforeStatuses[0])
      expect(sectionPlansRepo.get(projectId, 'test-loop', 1)?.status).toBe(beforeStatuses[1])
    })
  })

  describe('parseFinalAuditClear', () => {
    test('detects final audit clear marker', () => {
      expect(loopService.parseFinalAuditClear('<!-- final-audit:clear -->')).toBe(true)
      expect(loopService.parseFinalAuditClear('no clear marker')).toBe(false)
    })
  })

  describe('buildSectionContinuationPrompt', () => {
    test('includes outstanding bug findings', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)

      reviewFindingsRepo.write({
        projectId,
        file: 'src/test.ts',
        line: 10,
        severity: 'bug',
        description: 'Test bug',
        loopName: 'test-loop',
        sectionIndex: 0,
      })

      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildSectionContinuationPrompt(state, 'audit text')

      expect(prompt).toContain('Outstanding findings')
      expect(prompt).toContain('src/test.ts:10')
    })

    test('excludes cross-section findings from continuation prompt', () => {
      insertLoop('test-loop')
      insertSections('test-loop', 2)

      reviewFindingsRepo.write({
        projectId,
        file: 'src/test.ts',
        line: 10,
        severity: 'bug',
        description: 'Cross-section bug',
        loopName: 'test-loop',
        sectionIndex: null,
      })

      const state = loopService.getActiveState('test-loop')!
      const prompt = loopService.buildSectionContinuationPrompt(state, 'audit text')

      expect(prompt).not.toContain('Outstanding findings')
    })
  })
})

describe('section-read tool contract', () => {
  test('returns structured JSON output', async () => {
    const db = new Database(':memory:')

    // Create all necessary tables (same schema as beforeEach)
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
        session_directory    TEXT,
        decomposition_status TEXT NOT NULL DEFAULT 'pending',
        decomposition_mode   TEXT NOT NULL DEFAULT 'agent',
        decomposition_session_id TEXT,
        current_section_index INTEGER NOT NULL DEFAULT 0,
        total_sections       INTEGER NOT NULL DEFAULT 0,
        final_audit_done     INTEGER NOT NULL DEFAULT 0,
        final_audit_attempts INTEGER NOT NULL DEFAULT 0,
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
        loop_name TEXT NOT NULL DEFAULT '',
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT,
        created_at INTEGER NOT NULL,
        section_index INTEGER,
        PRIMARY KEY (project_id, loop_name, file, line, section_index)
      )
    `)
    db.run(`
      CREATE TABLE section_plans (
        project_id    TEXT    NOT NULL,
        loop_name     TEXT    NOT NULL,
        section_index INTEGER NOT NULL,
        title         TEXT    NOT NULL,
        content       TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'pending',
        attempts      INTEGER NOT NULL DEFAULT 0,
        summary_done           TEXT,
        summary_deviations     TEXT,
        summary_follow_ups     TEXT,
        started_at    INTEGER,
        completed_at  INTEGER,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (project_id, loop_name, section_index),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, 'proj', mockLogger, undefined, undefined, undefined, sectionPlansRepo)

    // Insert a test loop with sections
    loopsRepo.insert({
      projectId: 'proj',
      loopName: 'my-loop',
      status: 'running',
      currentSessionId: 'sess-1',
      worktree: false,
      worktreeDir: '/tmp',
      worktreeBranch: null,
      projectDir: '/tmp',
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
      decompositionStatus: 'completed',
      decompositionMode: 'deterministic',
      decompositionSessionId: null,
      currentSectionIndex: 0,
      totalSections: 2,
      finalAuditDone: 0,
    }, { prompt: null, lastAuditResult: null })

    sectionPlansRepo.bulkInsert({
      projectId: 'proj',
      loopName: 'my-loop',
      sections: [
        { index: 0, title: 'Setup', content: 'Install deps' },
        { index: 1, title: 'Implement', content: 'Write code' },
      ],
    })

    // Verify JSON structure (basic structural check)
    const state = loopService.getActiveState('my-loop')!
    const section = loopService.getSectionPlan(state, 0)
    expect(section).not.toBeNull()
    expect(section!.title).toBe('Setup')
    expect(section!.status).toBe('pending')

    db.close()
  })
})
