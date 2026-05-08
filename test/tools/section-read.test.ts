import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/services/loop'
import { createSectionReadTool } from '../../src/tools/section-read'
import type { Logger } from '../../src/types'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('section-read tool', () => {
  let db: Database
  let dbPath: string
  let loopService: ReturnType<typeof createLoopService>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let tempDir: string
  const projectId = 'test-project'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'section-read-test-'))
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

  function insertLoop(loopName: string, opts?: { currentSectionIndex?: number; totalSections?: number; currentSessionId?: string }) {
    loopsRepo.insert({
      projectId,
      loopName,
      status: 'running',
      currentSessionId: opts?.currentSessionId ?? `${loopName}-session`,
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
      currentSectionIndex: opts?.currentSectionIndex ?? 0,
      totalSections: opts?.totalSections ?? 0,
      finalAuditDone: 0,
      finalAuditAttempts: 0,
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

  function makeToolContext(sessionID: string) {
    return { sessionID } as any
  }

  async function executeSectionRead(args?: { section_index?: number }, sessionID?: string): Promise<string> {
    const tool = createSectionReadTool({ loopService } as any)
    const result = await tool.execute(args ?? {}, makeToolContext(sessionID ?? ''))
    return typeof result === 'string' ? result : result.output
  }

  function parseJson(result: string) {
    return JSON.parse(result)
  }

  describe('error cases', () => {
    test('returns error when not in a loop session', async () => {
      const result = parseJson(await executeSectionRead({}, 'unknown-session'))
      expect(result.error).toContain('Not in a loop session')
    })

    test('returns error when loop not found', async () => {
      const result = parseJson(await executeSectionRead({}, 'nonexistent-session'))
      expect(result.error).toContain('Not in a loop session')
    })

    test('returns error when totalSections === 0', async () => {
      insertLoop('test-loop', { totalSections: 0 })
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.error).toContain('No sections available')
    })

    test('returns error for invalid section index (negative)', async () => {
      insertLoop('test-loop', { totalSections: 3 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({ section_index: -1 }, 'test-loop-session'))
      expect(result.error).toContain('Invalid section index -1')
    })

    test('returns error for invalid section index (>= totalSections)', async () => {
      insertLoop('test-loop', { totalSections: 3 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({ section_index: 3 }, 'test-loop-session'))
      expect(result.error).toContain('Invalid section index 3')
    })

    test('returns error when section not found in database', async () => {
      insertLoop('test-loop', { totalSections: 2 })
      insertSections('test-loop', 2)
      const result = parseJson(await executeSectionRead({ section_index: 1 }, 'test-loop-session'))
      expect(result.error).toBeUndefined()
      expect(result.index).toBe(1)
    })
  })

  describe('success cases', () => {
    test('returns correct section data for valid index', async () => {
      insertLoop('test-loop', { totalSections: 2 })
      insertSections('test-loop', 2)
      const result = parseJson(await executeSectionRead({ section_index: 0 }, 'test-loop-session'))
      expect(result.index).toBe(0)
      expect(result.title).toBe('Section 1')
      expect(result.content).toBe('Content for section 1')
      expect(result.status).toBe('pending')
      expect(result.summary_done).toBeNull()
      expect(result.summary_deviations).toBeNull()
      expect(result.summary_follow_ups).toBeNull()
    })

    test('returns lowest-index pending when currentSectionIndex points later', async () => {
      insertLoop('test-loop', { totalSections: 3, currentSectionIndex: 2 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.index).toBe(0)
      expect(result.title).toBe('Section 1')
      expect(result.content).toBe('Content for section 1')
    })

    test('returns lowest-index failed before later pending', async () => {
      insertLoop('test-loop', { totalSections: 2, currentSectionIndex: 1 })
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'failed')
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.index).toBe(0)
      expect(result.status).toBe('failed')
    })

    test('skips completed sections', async () => {
      insertLoop('test-loop', { totalSections: 3, currentSectionIndex: 2 })
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.index).toBe(1)
      expect(result.title).toBe('Section 2')
    })

    test('falls back to state.currentSectionIndex when all sections are completed', async () => {
      insertLoop('test-loop', { totalSections: 2, currentSectionIndex: 1 })
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setStatus(projectId, 'test-loop', 1, 'completed')
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.index).toBe(1)
      expect(result.title).toBe('Section 2')
    })

    test('explicit section_index still returns the requested section even if another incomplete section exists', async () => {
      insertLoop('test-loop', { totalSections: 3, currentSectionIndex: 2 })
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      const result = parseJson(await executeSectionRead({ section_index: 1 }, 'test-loop-session'))
      expect(result.index).toBe(1)
      expect(result.title).toBe('Section 2')
    })

    test('summary fields still populate when explicitly reading a completed section', async () => {
      insertLoop('test-loop', { totalSections: 2 })
      insertSections('test-loop', 2)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setSummary(projectId, 'test-loop', 0, {
        done: 'Implemented feature X',
        deviations: 'None',
        followUps: 'Handled in section 2',
      })
      const result = parseJson(await executeSectionRead({ section_index: 0 }, 'test-loop-session'))
      expect(result.summary_done).toBe('Implemented feature X')
      expect(result.summary_deviations).toBe('None')
      expect(result.summary_follow_ups).toBe('Handled in section 2')
    })

    test('no section statuses are changed by calling section-read()', async () => {
      insertLoop('test-loop', { totalSections: 2 })
      insertSections('test-loop', 2)

      const beforeStatuses = [
        sectionPlansRepo.get(projectId, 'test-loop', 0)?.status,
        sectionPlansRepo.get(projectId, 'test-loop', 1)?.status,
      ]

      await executeSectionRead({}, 'test-loop-session')

      expect(sectionPlansRepo.get(projectId, 'test-loop', 0)?.status).toBe(beforeStatuses[0])
      expect(sectionPlansRepo.get(projectId, 'test-loop', 1)?.status).toBe(beforeStatuses[1])
    })

    test('handles empty session ID gracefully', async () => {
      insertLoop('test-loop', { totalSections: 2 })
      insertSections('test-loop', 2)
      const result = parseJson(await executeSectionRead({}, ''))
      expect(result.error).toContain('Not in a loop session')
    })
  })

  describe('state-driven behavior', () => {
    test('returns lowest-index incomplete section instead of currentSectionIndex', async () => {
      insertLoop('test-loop', { currentSectionIndex: 2, totalSections: 5 })
      insertSections('test-loop', 5)
      const result = parseJson(await executeSectionRead({}, 'test-loop-session'))
      expect(result.index).toBe(0)
      expect(result.title).toBe('Section 1')
    })

    test('allows reading sections beyond current index', async () => {
      insertLoop('test-loop', { currentSectionIndex: 0, totalSections: 3 })
      insertSections('test-loop', 3)
      const result = parseJson(await executeSectionRead({ section_index: 2 }, 'test-loop-session'))
      expect(result.index).toBe(2)
      expect(result.title).toBe('Section 3')
    })

    test('allows reading previously completed sections', async () => {
      insertLoop('test-loop', { currentSectionIndex: 1, totalSections: 3 })
      insertSections('test-loop', 3)
      sectionPlansRepo.setStatus(projectId, 'test-loop', 0, 'completed')
      sectionPlansRepo.setSummary(projectId, 'test-loop', 0, {
        done: 'Section 0 done',
      })
      const result = parseJson(await executeSectionRead({ section_index: 0 }, 'test-loop-session'))
      expect(result.index).toBe(0)
      expect(result.title).toBe('Section 1')
      expect(result.status).toBe('completed')
      expect(result.summary_done).toBe('Section 0 done')
    })
  })
})
